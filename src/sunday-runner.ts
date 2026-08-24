/**
 * Sunday runner — orchestrates live-summary across all 5 BEC services on a Sunday.
 *
 *   Every POLL_INTERVAL_MS, fetches the GBI BARSI channel RSS.
 *   For each new "Ibadah Raya N" live stream that started TODAY (WIB):
 *     - Record it in state
 *     - Schedule live-summary to fire at (stream publishedAt + TRIGGER_DELAY_MS)
 *     - At fire time, spawn live-summary.ts as a child for CAPTURE_DURATION_MS
 *     - Output per-service: ./runs/{date}/service-N-{videoId}/{transcript,summaries,meta}.{txt,json}
 *
 *   The state file (./runs/{date}/state.json) persists, so restarts resume.
 *
 *   Run on user laptop (or VPS) Sunday morning before the first service.
 *   Stays foregrounded — Ctrl+C cleanly shuts down.
 *
 * Usage:
 *   GEMINI_API_KEY=... ASI1_API_KEY=... npx tsx src/sunday-runner.ts
 *
 *   To test before Sunday with a fake fixture (bypass RSS poll):
 *   FAKE_LIVE_NOW=<videoId>:<serviceN> npx tsx src/sunday-runner.ts
 */
import 'dotenv/config';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID ?? 'UChwc7uyPrVVGZ0TcZ_-Jdhg'; // GBI Baranangsiang
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? `${5 * 60 * 1000}`, 10);          // 5 min
const TRIGGER_DELAY_MS = parseInt(process.env.TRIGGER_DELAY_MS ?? `${20 * 60 * 1000}`, 10);        // start engine 20 min after stream went live
const CAPTURE_DURATION_MS = parseInt(process.env.CAPTURE_DURATION_MS ?? `${90 * 60 * 1000}`, 10);  // capture for 90 min per service
const SUMMARY_EVERY_MS = parseInt(process.env.SUMMARY_EVERY_MS ?? `${60 * 1000}`, 10);             // rolling summary cadence
const SERMON_TITLE_RE = /Ibadah\s+Raya\s+(\d+)/i;

// SINGLE-SERVICE MODE (production / Cloud Run): when SERVICE_NUMBER is set, wait
// for today's "Ibadah Raya N" to appear live in the channel feed, capture it, then exit.
// ALL-DAY MODE (local laptop): when unset, poll all day and schedule each detected service.
const SINGLE_SERVICE = process.env.SERVICE_NUMBER ? parseInt(process.env.SERVICE_NUMBER, 10) : null;
const WAIT_FOR_STREAM_TIMEOUT_MS = parseInt(process.env.WAIT_FOR_STREAM_TIMEOUT_MS ?? `${30 * 60 * 1000}`, 10);  // wait up to 30 min for stream to appear
const WAIT_FOR_STREAM_POLL_MS = parseInt(process.env.WAIT_FOR_STREAM_POLL_MS ?? `${60 * 1000}`, 10);              // poll every 60s while waiting

const todayWib = toWibDate(new Date().toISOString());
const RUN_DIR = process.env.RUN_DIR ?? join(__dirname, '..', 'runs', `run-${todayWib}`);
const STATE_FILE = join(RUN_DIR, 'state.json');

interface ServiceState {
  videoId: string;
  title: string;
  serviceNumber: number;
  publishedAt: string;       // ISO when stream went live
  scheduledStartAt: string;  // ISO = publishedAt + TRIGGER_DELAY_MS
  status: 'detected' | 'scheduled' | 'running' | 'completed' | 'failed';
  outputDir?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
}

interface RunState {
  channelId: string;
  startedAt: string;
  triggerDelayMs: number;
  captureDurationMs: number;
  services: Record<string, ServiceState>;  // keyed by videoId
}

function toWibDate(iso: string): string {
  const d = new Date(iso);
  const wibMs = d.getTime() + 7 * 3600 * 1000;
  return new Date(wibMs).toISOString().slice(0, 10);
}

function ts(): string { return new Date().toISOString(); }
function log(...args: unknown[]) { console.log(`[${ts()}]`, ...args); }

mkdirSync(RUN_DIR, { recursive: true });

let state: RunState = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : {
      channelId: CHANNEL_ID,
      startedAt: ts(),
      triggerDelayMs: TRIGGER_DELAY_MS,
      captureDurationMs: CAPTURE_DURATION_MS,
      services: {},
    };

function saveState() { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

interface FeedEntry { videoId: string; title: string; publishedAt: string; serviceNumber: number; }

// The /feeds/videos.xml endpoint returns 404 for this channel (creator opted out
// or YouTube deprecated it for some channels). Fallback: scrape /streams page for
// recent videoIds, then fetch /watch?v=<id> for each new one and parse title +
// startTimestamp + isLiveNow from ytInitialPlayerResponse.
// IMPORTANT: YouTube serves DEGRADED HTML to GCP datacenter IPs — `isLiveNow`
// gets stripped from the player response even when the stream IS live. We route
// these HTML fetches through the same Webshare proxy chain used by yt-dlp.
const seenVideoIds = new Set<string>();
// Bandwidth optimization: videoIds we've ruled out (not today / ended / no match).
// Once classified, we skip re-fetching their /watch on subsequent polls.
const classifiedNonLive = new Set<string>();

// Cookies path (mounted via Cloud Run secret at /secrets/youtube-cookies.txt).
// Used on discovery curl calls so they look like a logged-in user.
const COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH ?? '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? '';

// Cache the working proxy URL across polls (no re-discovery every 30s).
// YouTube serves DEGRADED HTML to GCP datacenter IPs — `isLiveNow` gets stripped
// from the player response even when the stream IS live. We route HTML fetches
// through the same Webshare proxy chain used by yt-dlp. Using curl via child_process
// instead of undici/fetch — the npm `undici` package requires Node 22+ (markAsUncloneable),
// but the container runs Node 20, and we already have curl in the base image.
let cachedProxyUrl: string | null = null;
let proxyDiscoveryAttempted = false;

interface WebshareProxy { proxy_address: string; port: number; username: string; password: string; country_code: string; }

async function fetchWebshareProxies(): Promise<string[]> {
  const token = process.env.WEBSHARE_TOKEN;
  const gateway = process.env.WEBSHARE_GATEWAY ?? 'p.webshare.io:80';
  if (token) {
    try {
      // Use ROTATING RESIDENTIAL (mode=backbone). Datacenter IPs are uniformly
      // bot-blocked by YouTube. Residential rotates through real ISP IPs via the
      // gateway p.webshare.io:80; each session-suffixed username (vdjglhjw-N)
      // exits from a different residential IP.
      const r = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&valid=true&page_size=25', {
        headers: { Authorization: `Token ${token}` },
      });
      if (r.ok) {
        const j = await r.json() as { results: WebshareProxy[] };
        log(`[proxy] Webshare backbone returned ${j.results.length} residential sessions via ${gateway}`);
        const [gwHost, gwPort] = gateway.split(':');
        return j.results.map(p => `${gwHost}:${gwPort}:${p.username}:${p.password}`);
      }
    } catch (e) { log(`[proxy] Webshare API fetch threw: ${e instanceof Error ? e.message : e}`); }
  }
  // Static fallback from PROXIES env (mirror of live-summary.ts behavior)
  const list = (process.env.PROXIES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length) log(`[proxy] using ${list.length} static PROXIES from env`);
  return list;
}

// Fetch an HTTPS URL via curl with Chrome-like headers.
// YouTube's bot detector fingerprints TLS + headers + behavior; sending realistic
// browser headers (Sec-CH-UA-*, Accept-Language, Referer chain) materially reduces
// the rate at which residential sessions get bot-flagged.
async function curlFetch(url: string, proxyUrl: string | null, opts: { timeoutSec?: number; cookies?: string; referer?: string } = {}): Promise<string | null> {
  const timeoutSec = opts.timeoutSec ?? 12;
  const args = [
    '-sL', '--compressed',
    '--max-time', String(timeoutSec),
    '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '-H', 'Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    '-H', 'Cache-Control: no-cache',
    '-H', 'Pragma: no-cache',
    '-H', 'Sec-Fetch-Dest: document',
    '-H', 'Sec-Fetch-Mode: navigate',
    '-H', 'Sec-Fetch-Site: ' + (opts.referer ? 'same-origin' : 'none'),
    '-H', 'Sec-Fetch-User: ?1',
    '-H', 'Upgrade-Insecure-Requests: 1',
    '-H', 'Sec-CH-UA: "Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    '-H', 'Sec-CH-UA-Mobile: ?0',
    '-H', 'Sec-CH-UA-Platform: "macOS"',
  ];
  if (opts.referer) args.push('-H', `Referer: ${opts.referer}`);
  if (opts.cookies) args.push('-b', opts.cookies);
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch { return null; }
}

// Test against /watch (not /streams) — /streams loads even for bot-flagged sessions
// but /watch returns degraded HTML (missing isLiveContent) for the same session.
// A stable past-live video ID from this channel works as the litmus test.
const PROXY_TEST_VID = process.env.PROXY_TEST_VID ?? 'A-V7J54kgWg';  // Ibadah Raya 1 14.06.2026

async function probeProxy(proxyUrl: string | null): Promise<{ ok: boolean; reason: string }> {
  const html = await curlFetch(`https://www.youtube.com/watch?v=${PROXY_TEST_VID}`, proxyUrl, { timeoutSec: 10, cookies: COOKIES_PATH });
  if (!html) return { ok: false, reason: 'no response' };
  if (html.length < 50_000) return { ok: false, reason: `tiny response (${html.length}B)` };
  if (!html.includes('"isLiveContent"')) return { ok: false, reason: 'no isLiveContent field (bot wall)' };
  return { ok: true, reason: 'OK' };
}

// Session rotation: each call to nextWorkingProxy() picks a fresh session
// that passes the /watch probe. Caches the most-recently-good one but rotates
// when it starts returning degraded content mid-poll.
let availableProxies: string[] = [];
let lastProxyIndex = -1;

async function ensureProxyList() {
  if (availableProxies.length === 0) availableProxies = await fetchWebshareProxies();
}

async function nextWorkingProxy(): Promise<string | null> {
  await ensureProxyList();
  // Walk forward from lastProxyIndex; reusing the cached one is fine if it still probes OK.
  for (let attempts = 0; attempts < availableProxies.length; attempts++) {
    const idx = (lastProxyIndex + 1 + attempts) % availableProxies.length;
    const p = availableProxies[idx];
    const [host, port, user, pass] = p.split(':');
    const proxyUrl = `http://${user}:${pass}@${host}:${port}`;
    const res = await probeProxy(proxyUrl);
    if (res.ok) {
      lastProxyIndex = idx;
      cachedProxyUrl = proxyUrl;
      log(`[proxy] ✓ ${user}@${host}:${port} (session ${idx + 1}/${availableProxies.length})`);
      return proxyUrl;
    } else {
      log(`[proxy] ✗ ${user}@${host}:${port} — ${res.reason}`);
    }
  }
  log('[proxy] ⚠ no working session — falling back to direct (will likely fail)');
  return null;
}

async function discoverWorkingProxy(): Promise<string | null> {
  if (cachedProxyUrl) {
    // Verify the cached session is still good — proxy IPs get flagged by YT after
    // ~30 min of repeated /watch calls. If degraded, rotate to next session.
    const probe = await probeProxy(cachedProxyUrl);
    if (probe.ok) return cachedProxyUrl;
    log(`[proxy] ⚠ cached session degraded (${probe.reason}); rotating`);
  }
  return nextWorkingProxy();
}

// PRIMARY discovery — YouTube Data API v3 search.list with eventType=live.
// No bot detection, no proxy, no scraping. Returns currently-broadcasting videos
// on the target channel. ~100 quota units per call, daily quota 10,000 — plenty.
// Falls through to HTML scraping if API errors / key missing / quota exhausted.
interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: { title: string; publishedAt: string; liveBroadcastContent: string };
}
async function fetchLiveViaYouTubeAPI(): Promise<FeedEntry[]> {
  if (!YOUTUBE_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${CHANNEL_ID}&eventType=live&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) {
      log(`[api] search.list failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return [];
    }
    const j = await r.json() as { items?: YouTubeSearchItem[] };
    const items = j.items ?? [];
    if (items.length === 0) {
      log(`[api] search.list returned 0 live videos`);
      return [];
    }
    const out: FeedEntry[] = [];
    for (const it of items) {
      const videoId = it.id.videoId;
      const title = (it.snippet.title ?? '').replace(/&amp;/g, '&');
      const publishedAt = it.snippet.publishedAt;
      const m = title.match(SERMON_TITLE_RE);
      if (!m) continue;
      if (toWibDate(publishedAt) !== todayWib) continue;
      out.push({ videoId, title, publishedAt, serviceNumber: parseInt(m[1], 10) });
      log(`[api] ✓ live: ${videoId} svc=${m[1]} title="${title.slice(0, 60)}"`);
    }
    return out;
  } catch (e) {
    log(`[api] threw: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

async function fetchTodaysSermons(): Promise<FeedEntry[]> {
  // Try the official API first. Zero bot-detection surface area.
  const apiResults = await fetchLiveViaYouTubeAPI();
  if (apiResults.length > 0) return apiResults;

  // Fallback: HTML scraping via residential proxy. Used when API quota is
  // exhausted, API has indexing lag (stream just went live <30s ago), or the
  // API key is unavailable.
  const proxyUrl = await discoverWorkingProxy();
  const streamsUrl = `https://www.youtube.com/channel/${CHANNEL_ID}/streams`;
  const html = await curlFetch(streamsUrl, proxyUrl, { cookies: COOKIES_PATH });
  if (!html) throw new Error(`/streams fetch failed (proxy=${proxyUrl ? 'yes' : 'direct'})`);

  // Dedup videoIds in page order (YouTube repeats each id many times in DOM)
  const ids: string[] = [];
  const seen = new Set<string>();
  const idRe = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let m;
  while ((m = idRe.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  // Only need the most recent ~8 candidates (5 services per Sunday + buffer)
  const candidates = ids.slice(0, 8);

  const out: FeedEntry[] = [];
  const debugRows: string[] = [];
  const now = Date.now();
  // Acceptance window: a stream that started within the last 3 hours AND has no endTimestamp
  // is treated as "currently live".
  const MAX_AGE_MS = 3 * 60 * 60 * 1000;  // 3h

  // Bandwidth optimization: once we've classified a videoId as not-today/ended/no-title-match,
  // skip re-fetching it on subsequent polls. Saves ~8MB per poll.
  // `seenVideoIds` is the dedup set; `classifiedNonLive` tracks IDs we've ruled out.
  // (Stored on the function via module-level closure so it survives across calls.)
  for (const id of candidates) {
    if (classifiedNonLive.has(id)) {
      debugRows.push(`${id}: skipped (already classified non-live)`);
      continue;
    }
    let degraded = false;
    // Use a FRESH session for each /watch — sessions get bot-flagged after few requests.
    // Also include cookies + referer chain (came from /streams) for human-like signals.
    const sessionForThis = await nextWorkingProxy();
    const fetchOpts = {
      cookies: COOKIES_PATH,
      referer: `https://www.youtube.com/channel/${CHANNEL_ID}/streams`,
    };
    try {
      let watchHtml = await curlFetch(`https://www.youtube.com/watch?v=${id}`, sessionForThis, fetchOpts);
      // Detect degraded response (bot-detection page) and rotate ONE more time.
      if (watchHtml && watchHtml.length > 30_000 && !watchHtml.includes('"isLiveContent"')) {
        log(`[discovery] ⚠ degraded /watch for ${id} — rotating session again`);
        degraded = true;
        const fresh = await nextWorkingProxy();
        if (fresh) {
          watchHtml = await curlFetch(`https://www.youtube.com/watch?v=${id}`, fresh, fetchOpts);
        }
      }
      if (!watchHtml) { debugRows.push(`${id}: no watch html`); continue; }

      const title = watchHtml.match(/"title":"([^"]+)"/)?.[1]?.replace(/\\u0026/g, '&').replace(/\\"/g, '"');
      const isLiveNow = watchHtml.match(/"isLiveNow":(true|false)/)?.[1];
      const startTimestamp = watchHtml.match(/"startTimestamp":"([^"]+)"/)?.[1];
      const endTimestamp = watchHtml.match(/"endTimestamp":"([^"]+)"/)?.[1];
      const isLiveContent = watchHtml.match(/"isLiveContent":(true|false)/)?.[1] === 'true';

      const m2 = title?.match(SERMON_TITLE_RE);
      const startedAgoMs = startTimestamp ? (now - new Date(startTimestamp).getTime()) : Infinity;
      const startedWibDate = startTimestamp ? toWibDate(startTimestamp) : '-';
      const ageMin = Number.isFinite(startedAgoMs) ? Math.round(startedAgoMs / 60000) : '?';

      debugRows.push(`${id}: svc=${m2?.[1] ?? '-'} live=${isLiveNow ?? '?'} liveContent=${isLiveContent} startWIB=${startedWibDate} age=${ageMin}m ended=${endTimestamp ? 'yes' : 'no'} title="${title?.slice(0, 40) ?? '-'}"${degraded ? ' [rotated]' : ''}`);

      // If still degraded after rotation, do NOT classify — give it another shot next poll.
      if (!isLiveContent) continue;

      // From here we have valid player metadata — classify.
      if (!title || !startTimestamp) { classifiedNonLive.add(id); continue; }
      if (!m2) { classifiedNonLive.add(id); continue; }
      if (startedWibDate !== todayWib) { classifiedNonLive.add(id); continue; }

      const looksLive = startedAgoMs < MAX_AGE_MS && !endTimestamp;
      if (!looksLive) { classifiedNonLive.add(id); continue; }

      out.push({ videoId: id, title, publishedAt: startTimestamp, serviceNumber: parseInt(m2[1], 10) });
      seenVideoIds.add(id);
    } catch (e) { debugRows.push(`${id}: error ${e instanceof Error ? e.message : e}`); }
  }
  // Emit debug snapshot per poll so we can diagnose future failures from logs alone.
  if (debugRows.length) log(`[discovery] ${debugRows.length} candidates examined:\n  ` + debugRows.join('\n  '));
  return out;
}

function scheduleCapture(svc: ServiceState) {
  const delay = Math.max(0, new Date(svc.scheduledStartAt).getTime() - Date.now());
  log(`▶ scheduled service ${svc.serviceNumber} (${svc.videoId}) to start in ${(delay / 60000).toFixed(1)} min`);
  svc.status = 'scheduled';
  saveState();
  setTimeout(() => startCapture(svc), delay);
}

function startCapture(svc: ServiceState) {
  const outDir = join(RUN_DIR, `service-${svc.serviceNumber}-${svc.videoId}`);
  mkdirSync(outDir, { recursive: true });
  svc.outputDir = outDir;
  svc.startedAt = ts();
  svc.status = 'running';
  saveState();

  // In production (Docker) we run compiled JS from dist/. In local dev we use tsx + src/.
  const isCompiled = __filename.endsWith('.js') && __dirname.endsWith('dist');
  const childCmd: [string, string[]] = isCompiled
    ? ['node', [join(__dirname, 'live-summary.js'), `https://www.youtube.com/watch?v=${svc.videoId}`]]
    : ['npx', ['tsx', 'src/live-summary.ts', `https://www.youtube.com/watch?v=${svc.videoId}`]];

  log(`▶▶ STARTING capture: service ${svc.serviceNumber} (${svc.videoId}) → ${outDir}`);
  const child: ChildProcess = spawn(childCmd[0], childCmd[1], {
    env: {
      ...process.env,
      OUTPUT_DIR: outDir,
      MAX_DURATION_MS: String(CAPTURE_DURATION_MS),
      SUMMARY_EVERY_MS: String(SUMMARY_EVERY_MS),
      // Pass metadata for Firestore registration + GCS prefixing
      SERVICE_NUMBER: String(svc.serviceNumber),
      SERMON_DATE: toWibDate(svc.publishedAt),
      VIDEO_TITLE: svc.title,
      GCS_PREFIX: `run-${toWibDate(svc.publishedAt)}`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  child.on('exit', (code) => {
    svc.endedAt = ts();
    svc.exitCode = code ?? -1;
    svc.status = code === 0 ? 'completed' : 'failed';
    if (code !== 0) svc.error = `exit code ${code}`;
    saveState();
    log(`◀ service ${svc.serviceNumber} ${svc.status} (exit ${code})`);
  });
}

async function pollAndSchedule() {
  try {
    const sermons = await fetchTodaysSermons();
    log(`poll: ${sermons.length} sermon entries today`);
    for (const s of sermons) {
      if (state.services[s.videoId]) continue;
      const scheduledStartAt = new Date(new Date(s.publishedAt).getTime() + TRIGGER_DELAY_MS).toISOString();
      const svc: ServiceState = {
        videoId: s.videoId,
        title: s.title,
        serviceNumber: s.serviceNumber,
        publishedAt: s.publishedAt,
        scheduledStartAt,
        status: 'detected',
      };
      state.services[s.videoId] = svc;
      saveState();
      log(`  + NEW: service ${s.serviceNumber} (${s.videoId}) "${s.title.slice(0, 50)}" — went live at ${s.publishedAt}`);
      scheduleCapture(svc);
    }
  } catch (err) {
    log(`poll error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function rescheduleExistingOnRestart() {
  // If we crash/restart mid-day, recover pending scheduled/detected services
  for (const svc of Object.values(state.services)) {
    if (svc.status === 'detected' || svc.status === 'scheduled') {
      const fireAt = new Date(svc.scheduledStartAt).getTime();
      if (fireAt < Date.now() - CAPTURE_DURATION_MS) {
        log(`  ⊘ skipping service ${svc.serviceNumber} (${svc.videoId}) — fire time long past`);
        svc.status = 'failed';
        svc.error = 'missed window on restart';
        saveState();
        continue;
      }
      scheduleCapture(svc);
    }
  }
}

// Manual re-run escape hatch (HLD Item 3, docs/HLD-sermon-capture-resilience.md
// in this repo): the admin portal already knows the exact videoId of a capture
// it wants retried — polling to rediscover it is unnecessary and just adds a
// delay. Distinct from FAKE_LIVE_NOW (that one only fires in the ALL-DAY
// polling branch of main(), which the deployed Cloud Run job never takes,
// since the scheduler always sets SERVICE_NUMBER — that branch is dead code
// in production).
async function startKnownVideoCapture(N: number, videoId: string, title: string): Promise<void> {
  log(`TARGET_VIDEO_ID mode: capturing ${videoId} as service ${N} directly, no discovery`);
  const svc: ServiceState = {
    videoId,
    title,
    serviceNumber: N,
    publishedAt: new Date().toISOString(),
    scheduledStartAt: new Date().toISOString(),
    status: 'detected',
  };
  state.services[videoId] = svc;
  saveState();
  startCapture(svc);
  await new Promise<void>((resolve) => {
    const wait = setInterval(() => {
      if (svc.status === 'completed' || svc.status === 'failed') {
        clearInterval(wait);
        resolve();
      }
    }, 5000);
  });
  log(`Manual re-run done. Service ${N} status: ${svc.status}`);
}

async function singleServiceMode(N: number): Promise<void> {
  const targetVideoId = process.env.TARGET_VIDEO_ID;
  if (targetVideoId) {
    await startKnownVideoCapture(N, targetVideoId, process.env.TARGET_VIDEO_TITLE ?? `[RE-RUN] Ibadah Raya ${N}`);
    return;
  }

  log(`SINGLE-SERVICE MODE: target service ${N}`);
  log(`Waiting up to ${WAIT_FOR_STREAM_TIMEOUT_MS / 60000} min for "Ibadah Raya ${N}" to appear live today (WIB)`);
  const deadline = Date.now() + WAIT_FOR_STREAM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const sermons = await fetchTodaysSermons();
      const match = sermons.find((s) => s.serviceNumber === N);
      if (match) {
        log(`✓ Found service ${N}: ${match.videoId} (live since ${match.publishedAt})`);
        const svc: ServiceState = {
          videoId: match.videoId,
          title: match.title,
          serviceNumber: match.serviceNumber,
          publishedAt: match.publishedAt,
          scheduledStartAt: new Date().toISOString(),  // start NOW (we're already at trigger time)
          status: 'detected',
        };
        state.services[match.videoId] = svc;
        saveState();
        startCapture(svc);
        // Block until capture finishes — the child process keeps us alive.
        // When child exits, the 'exit' handler updates state. Then we exit.
        await new Promise<void>((resolve) => {
          const wait = setInterval(() => {
            if (svc.status === 'completed' || svc.status === 'failed') {
              clearInterval(wait);
              resolve();
            }
          }, 5000);
        });
        log(`Single-service mode done. Service ${N} status: ${svc.status}`);
        return;
      }
      log(`  not yet live — retry in ${WAIT_FOR_STREAM_POLL_MS / 1000}s`);
    } catch (err) {
      log(`  poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise<void>((r) => setTimeout(r, WAIT_FOR_STREAM_POLL_MS));
  }
  log(`✗ Timeout: "Ibadah Raya ${N}" never went live within ${WAIT_FOR_STREAM_TIMEOUT_MS / 60000} min. Exiting.`);
}

async function main() {
  log('Sunday runner starting');
  log(`Channel:  ${CHANNEL_ID}`);
  log(`Today:    ${todayWib} (WIB)`);
  log(`Run dir:  ${RUN_DIR}`);
  log(`Mode:     ${SINGLE_SERVICE ? `SINGLE-SERVICE (N=${SINGLE_SERVICE})` : 'ALL-DAY POLLING'}`);

  if (SINGLE_SERVICE !== null) {
    await singleServiceMode(SINGLE_SERVICE);
    process.exit(0);
  }

  // Test mode: skip RSS, schedule a fake service immediately
  const fake = process.env.FAKE_LIVE_NOW;  // format: <videoId>:<serviceN>
  if (fake) {
    const [vid, n] = fake.split(':');
    const svc: ServiceState = {
      videoId: vid,
      title: `[FAKE] Ibadah Raya ${n}`,
      serviceNumber: parseInt(n, 10),
      publishedAt: new Date(Date.now() - TRIGGER_DELAY_MS).toISOString(),
      scheduledStartAt: new Date().toISOString(),
      status: 'detected',
    };
    state.services[vid] = svc;
    saveState();
    log(`FAKE mode: scheduling ${vid} (service ${n}) to start NOW`);
    scheduleCapture(svc);
  } else {
    log(`Cadence: poll every ${POLL_INTERVAL_MS / 60000} min · trigger +${TRIGGER_DELAY_MS / 60000} min after stream start · capture max ${CAPTURE_DURATION_MS / 60000} min`);
    rescheduleExistingOnRestart();
    await pollAndSchedule();
    setInterval(pollAndSchedule, POLL_INTERVAL_MS);
  }

  process.on('SIGINT', () => {
    log('SIGINT — saving state and exiting');
    saveState();
    process.exit(0);
  });

  // Keep alive (all-day mode)
  process.stdin.resume();
}

main().catch((err) => { log('fatal:', err); process.exit(1); });
