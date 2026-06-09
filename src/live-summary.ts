/**
 * Live transcription + rolling summarization.
 *   audio  →  Gemini 3.1 Flash Live (transcribes)  →  ASI1 Mini (summarizes every N sec)
 *
 * Usage:
 *   ASI1_API_KEY=... GEMINI_API_KEY=... npx tsx src/live-summary.ts <youtube-live-url>
 */
import 'dotenv/config';
import { spawn, ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// MUST stay in sync with gbi-bec-youtube-sermon-sync/src/sanitize.ts —
// promote to shared lib at ideation root when both projects continue evolving.
const TYPO_FIXES: [RegExp, string][] = [
  [/\bBELANGGU\b/g, 'BELENGGU'],
  [/\bBELENGGUK\b/g, 'BELENGGU'],
  [/\bKEKAKUTAN\b/g, 'KETAKUTAN'],
  [/\bRajaWali\b/g, 'Rajawali'],
  [/\bRaja Wali\b/g, 'Rajawali'],
  [/\bTetelestyai\b/g, 'Tetelestai'],
  [/\bTelestyai\b/g, 'Tetelestai'],
  [/\bAmanat agung\b/g, 'Amanat Agung'],
  [/\bPentakosta ke-?tiga\b/gi, 'Pentakosta Ketiga'],
];
function fixTypos(s: string): string {
  return TYPO_FIXES.reduce((acc, [re, replacement]) => acc.replace(re, replacement), s);
}

const URL = process.argv[2];
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ASI1_KEY = process.env.ASI1_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-live-preview';
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS ?? '240000', 10);  // 4 min default
const SUMMARY_EVERY_MS = parseInt(process.env.SUMMARY_EVERY_MS ?? '60000', 10); // every 1 min
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? '/tmp';                            // per-run output dir
const GCS_BUCKET = process.env.GCS_BUCKET;                                       // optional — uploads on finish
const GCS_PREFIX = process.env.GCS_PREFIX ?? '';                                 // optional path prefix in bucket
const WRITE_FIRESTORE = process.env.WRITE_FIRESTORE === '1';                    // when set, register capture in Firestore for admin UI
const SERVICE_NUMBER = process.env.SERVICE_NUMBER;                              // passed by sunday-runner via inheritance
const SERMON_DATE = process.env.SERMON_DATE;                                    // YYYY-MM-DD WIB — passed by sunday-runner
const VIDEO_TITLE = process.env.VIDEO_TITLE;                                    // raw YouTube title — passed by sunday-runner
mkdirSync(OUTPUT_DIR, { recursive: true });

if (!URL || !GEMINI_KEY || !ASI1_KEY) {
  console.error('Usage: GEMINI_API_KEY=... ASI1_API_KEY=... npx tsx src/live-summary.ts <url>');
  process.exit(1);
}

const TRANSCRIBE_SYSTEM = `Kamu adalah real-time transcriber untuk video live YouTube. Transkripkan apa yang dibicarakan secara incremental dan akurat. Output hanya teks transkrip, tanpa komentar atau ringkasan.`;

const SUMMARY_SYSTEM = `Kamu adalah rolling summarizer. Diberikan transkrip live dari sebuah podcast / talkshow / video YouTube, hasilkan ringkasan singkat (3-5 bullet points) berisi topik utama yang dibahas SO FAR. Tulis dalam bahasa Inggris kalau transkripnya Inggris, atau bahasa Indonesia kalau Indonesia. Fokus pada substansi: siapa berbicara, apa topiknya, klaim/argumen kunci. Singkat, padat, faktual.`;

interface Snapshot { atSec: number; summary: string; transcriptChars: number; }

let session: Session;
let proc: ChildProcess | null = null;
let transcript = '';
let lastSummaryAtChars = 0;
let totalBytes = 0;
const startTime = Date.now();
const snapshots: Snapshot[] = [];
let summarizing = false;

async function callAsi1Summary(fullTranscript: string): Promise<string> {
  // Apply BEC typo dictionary BEFORE summarization — closes silent inconsistency with the cron path
  const cleaned = fixTypos(fullTranscript);
  const resp = await fetch('https://api.asi1.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ASI1_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'asi1-mini',
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `LIVE TRANSCRIPT SO FAR:\n\n${cleaned}\n\n---\nProduce a rolling summary (3-5 bullets).` },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`ASI1 ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '(empty)';
}

async function main() {
  console.log(`URL: ${URL}`);
  console.log(`Gemini model (transcriber): ${GEMINI_MODEL}`);
  console.log(`ASI1 model (summarizer):    asi1-mini`);
  console.log(`Duration: ${MAX_DURATION_MS / 1000}s, summarize every ${SUMMARY_EVERY_MS / 1000}s\n`);

  // 1. Gemini Live session
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  session = await ai.live.connect({
    model: GEMINI_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: { languageCode: 'id-ID' },
      systemInstruction: TRANSCRIBE_SYSTEM,
    },
    callbacks: {
      onopen: () => console.log('[gemini] ✓ Live session open'),
      onmessage: (msg: LiveServerMessage) => {
        const t = msg.serverContent?.inputTranscription?.text;
        if (t) {
          transcript += t;
          process.stdout.write(t);
        }
      },
      onerror: (e: ErrorEvent) => console.error('\n[gemini] error:', e.message),
      onclose: (e: CloseEvent) => console.log(`\n[gemini] closed (${e.code}) ${e.reason ?? ''}`),
    },
  });

  // 2. m3u8 + ffmpeg PCM. yt-dlp resolution on GCP IPs requires either:
  //    - android client + no cookies (residential), OR
  //    - web client + cookies + Deno (GCP-IP path — the one that actually works on Cloud Run).
  // Cookies secret is mounted read-only at /secrets/youtube-cookies.txt — copy to /tmp
  // because yt-dlp writes session updates back to the cookie file.
  const cookiesSrc = process.env.YOUTUBE_COOKIES_PATH;
  let cookiesArg: string[] = [];
  let extractorArgs: string[] = ['--extractor-args', 'youtube:player_client=android'];  // default: no cookies → android
  console.log(`[yt-dlp] cookiesSrc env = ${cookiesSrc ?? '(unset)'}`);
  if (cookiesSrc) {
    const { copyFileSync, existsSync, statSync } = await import('node:fs');
    console.log(`[yt-dlp] cookies path exists? ${existsSync(cookiesSrc)} size=${existsSync(cookiesSrc) ? statSync(cookiesSrc).size : 0}`);
    const cookiesDest = join(OUTPUT_DIR, 'yt-cookies.txt');
    try {
      copyFileSync(cookiesSrc, cookiesDest);
      cookiesArg = ['--cookies', cookiesDest];
      extractorArgs = [];   // cookies path uses default web client + Deno; android rejects cookies
      console.log(`[yt-dlp] cookies copied to ${cookiesDest}, will use --cookies`);
    } catch (e) {
      console.warn('  ⚠ cookies copy failed, falling back to android client:', e instanceof Error ? e.message : e);
    }
  }
  // Proxy fallback chain: YouTube blocks GCP/AWS datacenter IPs at the
  // youtubei/v1/player layer (the manifest-URL extraction call). ffmpeg still
  // pulls HLS segments directly from googlevideo.com CDN without a proxy.
  // Source order: live Webshare API (always fresh — they rotate free-tier IPs)
  // → static PROXIES env fallback → direct.
  let proxyList: string[] = [];
  const webshareToken = process.env.WEBSHARE_TOKEN;
  if (webshareToken) {
    try {
      const r = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&valid=true&page_size=25', {
        headers: { Authorization: `Token ${webshareToken}` },
      });
      if (r.ok) {
        const j = await r.json() as { results: Array<{ proxy_address: string; port: number; username: string; password: string; country_code: string }> };
        proxyList = j.results.map(p => `${p.proxy_address}:${p.port}:${p.username}:${p.password}`);
        console.log(`[proxy] Webshare API returned ${proxyList.length} valid proxies (${j.results.map(p => p.country_code).join(',')})`);
      } else {
        console.warn(`[proxy] Webshare API failed (${r.status}), falling back to static PROXIES env`);
      }
    } catch (e) {
      console.warn(`[proxy] Webshare API fetch threw, falling back to static: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (proxyList.length === 0) {
    proxyList = (process.env.PROXIES ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (proxyList.length > 0) console.log(`[proxy] using ${proxyList.length} static PROXIES from env`);
  }
  const proxyAttempts: (string | null)[] = proxyList.length > 0 ? [...proxyList, null] : [null];
  const baseArgs = ['--no-update', '--quiet', '--no-warnings', ...extractorArgs, ...cookiesArg, '-f', '91', '--get-url', URL!];

  let m3u8Url = '';
  let workingProxyUrl: string | null = null;
  let lastErr = '';
  for (const proxyEntry of proxyAttempts) {
    let args = baseArgs;
    let label = 'direct';
    let proxyUrl: string | null = null;
    if (proxyEntry) {
      const [host, port, user, pass] = proxyEntry.split(':');
      proxyUrl = `http://${user}:${pass}@${host}:${port}`;
      args = ['--proxy', proxyUrl, ...baseArgs];
      label = `${host}:${port}`;
    }
    console.log(`[yt-dlp] attempt via ${label} — cmd: yt-dlp ${args.join(' ').replace(/[A-Za-z0-9_/.-]+yt-cookies\.txt/g, '<cookies>').replace(/http:\/\/[^@]+@/g, 'http://<creds>@')}`);
    try {
      m3u8Url = await new Promise<string>((resolve, reject) => {
        const yt = spawn('yt-dlp', args);
        let out = '';
        let err = '';
        yt.stdout.on('data', (d) => out += d.toString());
        yt.stderr.on('data', (d) => err += d.toString());
        yt.on('exit', (code) => code === 0 && out.trim() ? resolve(out.trim().split('\n')[0]) : reject(new Error(`yt-dlp exit ${code}: ${err.slice(0, 300)}`)));
      });
      console.log(`[yt-dlp] ✓ got manifest via ${label}`);
      workingProxyUrl = proxyUrl;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(`[yt-dlp] ✗ ${label} failed: ${lastErr.slice(0, 200)}`);
    }
  }
  if (!m3u8Url) throw new Error(`all yt-dlp attempts failed. last error: ${lastErr}`);

  // googlevideo CDN tokenizes manifest URLs with /ip/<extractor-ip>/ — segments
  // pulled from a different IP get rejected. So ffmpeg must use the SAME proxy
  // that fetched the manifest. Free tier Webshare has unlimited bandwidth.
  const ffmpegEnv = workingProxyUrl
    ? { ...process.env, http_proxy: workingProxyUrl, https_proxy: workingProxyUrl, HTTP_PROXY: workingProxyUrl, HTTPS_PROXY: workingProxyUrl }
    : process.env;
  console.log(`[ffmpeg] starting PCM capture${workingProxyUrl ? ' via proxy' : ' (direct)'}\n`);

  proc = spawn('ffmpeg', [
    '-i', m3u8Url, '-vn', '-ar', '16000', '-ac', '1', '-f', 's16le', '-loglevel', 'error', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv });

  proc.stdout!.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    try {
      session.sendRealtimeInput({
        audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch { /* drop chunk if session closed */ }
  });

  // 3. Rolling summary every N seconds
  const summaryTimer = setInterval(async () => {
    if (summarizing) return;
    if (transcript.length - lastSummaryAtChars < 200) return;  // skip if too little new content
    summarizing = true;
    const atSec = Math.round((Date.now() - startTime) / 1000);
    try {
      const summary = await callAsi1Summary(transcript);
      lastSummaryAtChars = transcript.length;
      snapshots.push({ atSec, summary, transcriptChars: transcript.length });
      console.log(`\n\n╔════ ASI1 ROLLING SUMMARY @${atSec}s · ${transcript.length} transcript chars ════════════╗`);
      summary.split('\n').forEach((l) => console.log(`║  ${l}`));
      console.log(`╚════════════════════════════════════════════════════════════════════════════════╝\n`);
    } catch (e) {
      console.error('\n[asi1] summary failed:', e);
    } finally {
      summarizing = false;
    }
  }, SUMMARY_EVERY_MS);

  // 4a. Auto-stop: STREAM ENDS — ffmpeg exits when the live manifest stops being updated
  //     (i.e., the church ended the broadcast). Finalize immediately on natural end.
  proc.on('exit', (code) => {
    if (finished) return;
    console.log(`\n\n[ffmpeg] exited (code ${code}) — stream ended, finalizing`);
    clearInterval(summaryTimer);
    finish('stream-ended');
  });

  // 4b. Hard ceiling — never run longer than MAX_DURATION_MS no matter what
  setTimeout(() => {
    if (finished) return;
    console.log(`\n\n[timer] max duration ${MAX_DURATION_MS / 1000}s reached`);
    clearInterval(summaryTimer);
    finish('max-duration');
  }, MAX_DURATION_MS);
}

let finished = false;
function finish(reason: string = 'unknown') {
  if (finished) return;
  finished = true;
  console.log(`\n[end] finalizing (reason: ${reason})`);
  try { proc?.kill('SIGTERM'); } catch { /* noop */ }
  try { session?.close(); } catch { /* noop */ }
  setTimeout(async () => {
    console.log('\n\n' + '='.repeat(80));
    console.log('FINAL OUTPUTS');
    console.log('='.repeat(80));
    console.log(`\n→ RAW TRANSCRIPT (Gemini 3.1 Live), ${transcript.length} chars:\n`);
    console.log(transcript);
    console.log(`\n→ ASI1 ROLLING SUMMARIES (${snapshots.length} snapshots):\n`);
    snapshots.forEach((s, i) => {
      console.log(`\n--- snapshot ${i + 1} @${s.atSec}s (${s.transcriptChars} transcript chars) ---`);
      console.log(s.summary);
    });
    writeFileSync(join(OUTPUT_DIR, 'transcript.txt'), transcript);
    writeFileSync(join(OUTPUT_DIR, 'summaries.json'), JSON.stringify(snapshots, null, 2));
    writeFileSync(join(OUTPUT_DIR, 'meta.json'), JSON.stringify({
      url: URL, model: GEMINI_MODEL, durationMs: MAX_DURATION_MS,
      actualDurationMs: Date.now() - startTime, endReason: reason,
      transcriptChars: transcript.length, snapshotCount: snapshots.length,
      finishedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`\nSaved → ${OUTPUT_DIR}/{transcript.txt, summaries.json, meta.json}`);

    const uploadedPaths: Record<string, string> = {};
    if (GCS_BUCKET) {
      try {
        const storage = new Storage();
        const bucket = storage.bucket(GCS_BUCKET);
        for (const file of ['transcript.txt', 'summaries.json', 'meta.json']) {
          const localPath = join(OUTPUT_DIR, file);
          const remotePath = GCS_PREFIX
            ? `${GCS_PREFIX.replace(/\/$/, '')}/${basename(OUTPUT_DIR)}/${file}`
            : `${basename(OUTPUT_DIR)}/${file}`;
          await bucket.upload(localPath, { destination: remotePath, contentType: file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8' });
          uploadedPaths[file.replace(/\.\w+$/, '')] = `gs://${GCS_BUCKET}/${remotePath}`;
          console.log(`  ☁ uploaded gs://${GCS_BUCKET}/${remotePath}`);
        }
      } catch (e) {
        console.error('  ☁ GCS upload failed:', e instanceof Error ? e.message : e);
      }
    }

    if (WRITE_FIRESTORE) {
      try {
        if (!getApps().length) initializeApp({ credential: applicationDefault() });
        const db = getFirestore();
        const videoId = URL ? URL.split('v=')[1]?.split('&')[0] ?? URL : 'unknown';
        const docId = `${SERMON_DATE ?? 'unknown'}-service-${SERVICE_NUMBER ?? '0'}-${videoId}`;
        const lastSummary = snapshots.length ? snapshots[snapshots.length - 1].summary : '';
        await db.collection('sermon_captures').doc(docId).set({
          videoId,
          serviceNumber: SERVICE_NUMBER ? parseInt(SERVICE_NUMBER, 10) : null,
          sermonDate: SERMON_DATE ?? null,
          title: VIDEO_TITLE ?? null,
          url: URL,
          gcsPaths: uploadedPaths,
          transcriptChars: transcript.length,
          summarySnapshots: snapshots,
          latestSummary: lastSummary,
          endReason: reason,
          actualDurationMs: Date.now() - startTime,
          status: 'captured',
          capturedAt: new Date().toISOString(),
          kabarId: null,    // populated when admin clicks "Create kabar draft"
          createdAt: new Date().toISOString(),
        });
        console.log(`  ✓ Firestore: wrote sermon_captures/${docId}`);
      } catch (e) {
        console.error('  ✗ Firestore write failed:', e instanceof Error ? e.message : e);
      }
    }
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', () => finish('sigint'));

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
