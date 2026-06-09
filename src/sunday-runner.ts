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
import { spawn, ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
const WAIT_FOR_STREAM_POLL_MS = parseInt(process.env.WAIT_FOR_STREAM_POLL_MS ?? `${30 * 1000}`, 10);              // poll every 30s while waiting

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
// publishDate from ytInitialPlayerResponse. The HTML pages aren't bot-protected
// (only the youtubei/v1/player endpoint is).
const seenVideoIds = new Set<string>();

async function fetchTodaysSermons(): Promise<FeedEntry[]> {
  const streamsUrl = `https://www.youtube.com/channel/${CHANNEL_ID}/streams`;
  const res = await fetch(streamsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bec-sunday-runner/1.0)' } });
  if (!res.ok) throw new Error(`/streams fetch failed: ${res.status}`);
  const html = await res.text();

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
  for (const id of candidates) {
    try {
      const watchRes = await fetch(`https://www.youtube.com/watch?v=${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bec-sunday-runner/1.0)' },
      });
      if (!watchRes.ok) continue;
      const watchHtml = await watchRes.text();
      const title = watchHtml.match(/"title":"([^"]+)"/)?.[1]?.replace(/\\u0026/g, '&').replace(/\\"/g, '"');
      // CURRENTLY-LIVE filter: isLive=true. (isLiveContent=true matches past live VODs too.)
      const isLiveNow = watchHtml.match(/"isLive":(true|false)/)?.[1] === 'true';
      // startTimestamp = actual broadcast start (UTC). publishDate is VOD-processing time, not useful for live.
      const startTimestamp = watchHtml.match(/"startTimestamp":"([^"]+)"/)?.[1];
      if (!title || !isLiveNow || !startTimestamp) continue;
      const m2 = title.match(SERMON_TITLE_RE);
      if (!m2) continue;
      // Safety: only accept streams that started today WIB (prevents capturing a stale "Ibadah Raya N" live from a past week)
      if (toWibDate(startTimestamp) !== todayWib) continue;
      out.push({ videoId: id, title, publishedAt: startTimestamp, serviceNumber: parseInt(m2[1], 10) });
      seenVideoIds.add(id);
    } catch { /* skip on individual failure */ }
  }
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

async function singleServiceMode(N: number): Promise<void> {
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
