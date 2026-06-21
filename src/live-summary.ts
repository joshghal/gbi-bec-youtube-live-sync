/**
 * Live transcription + single-pass final summarization.
 *   audio → Gemini 3.1 Flash Live (transcribes) → transcript buffer (in-memory)
 *   every 60s: transcript snapshot → GCS (so admins can peek live)
 *   on stream end (or hard cap, or audio-silent watchdog):
 *     transcript → Gemini 2.5 Pro (ONE call) → polished BEC-style catatan khotbah
 *     → GCS + Firestore
 *
 * Cost: ~$0.03/sermon (was ~$0.09 with 85 rolling ASI1 calls). Quality dramatically higher
 * because we use Gemini 2.5 Pro reasoning on the full transcript instead of incremental
 * passes on a weaker model.
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
const FINAL_SUMMARY_MODEL = process.env.FINAL_SUMMARY_MODEL ?? 'gemini-2.5-pro';  // one polished call at sermon end
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS ?? '240000', 10);  // 4 min default
const TRANSCRIPT_UPLOAD_EVERY_MS = parseInt(process.env.TRANSCRIPT_UPLOAD_EVERY_MS ?? '60000', 10); // upload raw transcript snapshot to GCS every minute
const SILENCE_WATCHDOG_MS = parseInt(process.env.SILENCE_WATCHDOG_MS ?? '60000', 10);  // finalize if no audio chunks in this window (after stream started)
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

// House style — catatan khotbah GBI BEC. Calibrated against published posts:
//   - menyembah-dalam-roh-catatan-khotbah-ibadah-raya-7-juni-2026
//   - nantikanlah-tuhan-catatan-khotbah-ibadah-raya-17-mei-2026
//   - catatan-khotbah-ibadah-raya-3-mei-2026
// Pattern: pastor name → theme (sentence case, selective CAPS on key word) →
// optional thesis → numbered sections with sub-bullets → verbatim Bible quotes.
// Strictly Bahasa Indonesia, note-style (not essay), close with "Tuhan Yesus memberkati."
const SUMMARY_SYSTEM = `Kamu adalah pencatat khotbah untuk GBI Baranangsiang Evening Church (BEC). Diberikan transkrip live ibadah, hasilkan catatan khotbah dalam GAYA jemaat BEC yang persis seperti contoh-contoh yang sudah dipublish di https://gbibec.id/kabar.

OUTPUT: 100% Bahasa Indonesia, gaya catatan (BUKAN esai prosa). Kalimat singkat, langsung ke poin.

STRUKTUR WAJIB:

[Baris 1] Nama pembicara — format: "Ps. <Nama>" atau "Pdt. <Nama>" atau "Pdp. <Nama>". Kalau belum jelas, tulis "Pembicara: -".

[Baris 2] Tema/judul khotbah dalam sentence case (Huruf Awal Saja). Boleh ada SATU kata kunci di-KAPITAL kalau pembicara menekankannya berulang-ulang (contoh: "Menyembah dalam ROH", "Pentingnya MERDEKA dari hidup yg dibelenggu KETAKUTAN").

[Body] Poin-poin utama. Gunakan campuran:
- Headers numerik untuk poin besar khotbah (sermon points): "1. Daud menangis", "2. Daud menolak pahit", dst.
- Bullet (-) dan sub-bullet untuk elaborasi di bawah header.
- Pernyataan thesis singkat 1 baris setelah header bila pembicara membuat klaim langsung.

REFERENSI ALKITAB (PRIORITAS UTAMA):
- WAJIB sertakan SETIAP referensi ayat Alkitab yang disebut pembicara di dalam catatan. Ini paling penting — catatan tanpa referensi ayat tidak berguna bagi jemaat.
- Pembicara biasanya menyebut referensi dalam bentuk lisan:
    "pasal yang pertama ayatnya yang kedua"  → tulis "Pengkhotbah 1:2" (dari kitab yang baru disebutkan)
    "Yohanes pasal yang ke-15 ayat yang pertama sampai yang kelima" → tulis "Yohanes 15:1-5"
    "Mazmur 23"  → tulis "Mazmur 23"
- Format singkat: "Yohanes 4:23-24", "Mazmur 27:14", "1 Samuel 30:1-4", "Pengkhotbah 1:2".
- Gunakan nama buku LENGKAP (Yohanes, Mazmur, Kisah Para Rasul, Matius, 1 Korintus, 2 Raja-raja, Pengkhotbah, Amsal). Singkatan (Kis, Mat, 1 Kor, Yes, Ams, Pkh) hanya kalau pembicara sendiri pakai singkatan.
- KALAU pembicara membaca ayat dengan kata-katanya secara lengkap (bukan parafrase), KUTIP LENGKAP teks ayatnya setelah referensinya dalam tanda kutip. Contoh:
    Yohanes 15:5 — "Akulah pokok anggur, kamulah ranting-rantingnya. Barangsiapa tinggal di dalam Aku..."
    Matius 22:37 — "Kasihilah Tuhan, Allahmu, dengan segenap hatimu..."
- Kalau referensi disebut tapi ayatnya tidak dibaca lengkap, tetap tulis referensinya — cukup tanpa kutipan.
- Setiap poin/section yang membahas suatu pasal harus diawali atau diakhiri dengan referensi pasalnya.

PENEKANAN (CAPS):
- Gunakan KAPITAL secara HEMAT — hanya untuk kata kunci/konsep yang ditekankan pembicara (contoh: ROH, HATI Tuhan, KASIH, MURAH HATI, TAAT, KETAKUTAN).
- Jangan jadikan semua header atau semua poin penting ber-CAPS. Pilih 3-7 konsep kunci sepanjang catatan.

BAHASA:
- Singkatan natural diperbolehkan kalau alami: dg, yg, Krn, utk, ttp, dlm, ke pada → kpd.
- Jangan menerjemahkan ke Inggris. Kalau pembicara nyanyi lagu berbahasa Inggris, kutip apa adanya (contoh: "Deeper in love with You").
- Pakai sudut pandang "kita/kami" kalau pembicara pakai sudut pandang itu.

ATURAN KETAT:
- JANGAN menambahkan informasi yang tidak ada di transkrip. Kalau pembicara belum menyebutkan namanya, jangan dikira-kira.
- JANGAN membuat sub-judul artifisial seperti "Pendahuluan", "Penutup", "Kesimpulan". Ikuti alur khotbah.
- Kalau transkrip masih berupa worship/pujian saja (belum khotbah), output: "Pembicara: -" lalu satu baris "Sesi pujian & penyembahan" dan ringkasan singkat tema lagu yang dinyanyikan.
- Karena ini ROLLING summary, ringkas SEMUA yang sudah dibahas sejauh ini (bukan hanya menit-menit terakhir).
- Tutup dengan "Tuhan Yesus memberkati." HANYA kalau pembicara sudah jelas-jelas menutup khotbah (frasa seperti "amin", "berkat", "kita berdoa"). Kalau khotbah masih berlangsung, JANGAN tutup dengan kalimat penutup.`;


let session: Session;
let proc: ChildProcess | null = null;
let transcript = '';
let totalBytes = 0;
const startTime = Date.now();

// FINAL summary — called once at end of capture on the COMPLETE transcript.
// Uses Gemini 2.5 Pro (better reasoning + Bahasa fluency than ASI1 Mini).
// Cost ~$0.03/sermon vs $0.09 with 85 rolling ASI1 calls. Higher quality output.
// Falls back to ASI1 Mini if Gemini Pro errors so we always have SOMETHING.
async function callGeminiFinalSummary(fullTranscript: string): Promise<string> {
  const cleaned = fixTypos(fullTranscript);
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  const videoTitleLine = VIDEO_TITLE
    ? `METADATA — Judul video YouTube: "${VIDEO_TITLE}"\n(Gunakan ini untuk mengisi baris pertama "Ps./Pdt. <Nama>" — JANGAN tebak nama atau gelar dari transkrip.)\n\n`
    : '';
  const userMsg = `${videoTitleLine}TRANSKRIP IBADAH (LENGKAP, sudah selesai):\n\n${cleaned}\n\n---\nIni adalah versi FINAL untuk dipublikasi sebagai catatan khotbah. Pembicara sudah menyelesaikan khotbahnya.\n\nBuat catatan khotbah lengkap dlm GAYA BEC. Ikuti SEMUA aturan di system prompt persis.\n\nWAJIB:\n1. Baris 1 = nama pembicara (ambil dari METADATA).\n2. Baris kosong.\n3. Baris 3 = tema khotbah.\n4. Baris kosong.\n5. Body: poin-poin numerik dg sub-bullet, atau bullet-and-explanation. SETIAP referensi ayat HARUS disertai penjelasan/kutipan; SETIAP poin penting HARUS disertai referensi ayat kalau pembicara menyebutnya.\n6. Format referensi: "Yohanes 15:5 — \\"Akulah pokok anggur...\\"" atau "Mazmur 23:1 (Tuhan adalah gembala)" atau standalone "(Yohanes 14:15-17)".\n7. Penutup: "Tuhan Yesus memberkati." (karena khotbah sudah selesai).\n8. Output HANYA catatan, tanpa pengantar/penutup AI/komentar.`;
  const resp = await ai.models.generateContent({
    model: FINAL_SUMMARY_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    config: {
      systemInstruction: SUMMARY_SYSTEM,
      temperature: 0.4,
      maxOutputTokens: 8192,
    },
  });
  return resp.text ?? '(empty)';
}

async function callAsi1Summary(fullTranscript: string): Promise<string> {
  // Apply BEC typo dictionary BEFORE summarization — closes silent inconsistency with the cron path
  const cleaned = fixTypos(fullTranscript);
  // Hand the model context the YouTube title contains so it can use the actual pastor name
  // (e.g. "Ibadah Raya 2 | Minggu, 14.06.2026 | Ps.Franky Kuncoro | GBI Baranangsiang")
  const videoTitleLine = VIDEO_TITLE ? `\nMETADATA — Judul video YouTube: "${VIDEO_TITLE}"\n(Gunakan ini untuk mengisi baris pertama "Ps./Pdt. <Nama>" — JANGAN tebak nama atau gelar dari transkrip.)\n` : '';
  const resp = await fetch('https://api.asi1.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ASI1_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'asi1-mini',
      temperature: 0.3,
      max_tokens: 900,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `${videoTitleLine}TRANSKRIP IBADAH (live, masih bertambah):\n\n${cleaned}\n\n---\nBuat catatan khotbah dlm gaya BEC. Ikuti aturan di system prompt persis.\n\nPENTING soal format:\n- Baris 1 = nama pembicara (ambil dari METADATA di atas kalau ada).\n- Baris 2 = KOSONG (blank line).\n- Baris 3 = tema khotbah.\n- Baris 4 = KOSONG.\n- Mulai poin-poin dari Baris 5.\n\nWAJIB — referensi Alkitab:\n- Scan transkrip untuk SEMUA referensi ayat yang disebut pembicara (cari kata kunci: "pasal", "ayat", nama-nama kitab seperti Yohanes/Mazmur/Pengkhotbah/Matius/Roma/Kisah/dst).\n- Konversi referensi lisan ke format standar (cth: "pasal pertama ayat kedua" dari kitab Pengkhotbah → "Pengkhotbah 1:2").\n- Setiap poin yang membahas suatu kitab/pasal HARUS menyertakan referensinya.\n- Kalau pembicara membaca ayat lengkap, kutip ayatnya verbatim.\n\nJangan tambahkan komentar di luar catatan.` },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`ASI1 ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '(empty)';
}

// Compute the eventual Firestore docId + GCS transcript path once, so the
// "capturing in progress" doc and the final doc share the same address.
function computeIdentity() {
  const videoId = URL ? URL.split('v=')[1]?.split('&')[0] ?? URL : 'unknown';
  const docId = `${SERMON_DATE ?? 'unknown'}-service-${SERVICE_NUMBER ?? '0'}-${videoId}`;
  const remotePath = GCS_PREFIX
    ? `${GCS_PREFIX.replace(/\/$/, '')}/${basename(OUTPUT_DIR)}/transcript.txt`
    : `${basename(OUTPUT_DIR)}/transcript.txt`;
  const gcsTranscriptUri = GCS_BUCKET ? `gs://${GCS_BUCKET}/${remotePath}` : '';
  return { videoId, docId, gcsTranscriptUri };
}

async function main() {
  console.log(`URL: ${URL}`);
  console.log(`Gemini model (transcriber): ${GEMINI_MODEL}`);
  console.log(`ASI1 model (summarizer):    asi1-mini`);
  console.log(`Duration: ${MAX_DURATION_MS / 1000}s, transcript snapshot every ${TRANSCRIPT_UPLOAD_EVERY_MS / 1000}s, single final summary at end\n`);
  console.log(`Final summarizer: ${FINAL_SUMMARY_MODEL}`);

  // 0. Write a "capturing in progress" Firestore doc IMMEDIATELY so the admin
  //    portal can show the live capture (and pull the GCS transcript as it grows).
  //    On finalize we'll UPDATE this same doc with the final summary + status='captured'.
  if (WRITE_FIRESTORE) {
    try {
      if (!getApps().length) initializeApp({ credential: applicationDefault() });
      const db = getFirestore();
      const { videoId, docId, gcsTranscriptUri } = computeIdentity();
      await db.collection('sermon_captures').doc(docId).set({
        videoId,
        serviceNumber: SERVICE_NUMBER ? parseInt(SERVICE_NUMBER, 10) : null,
        sermonDate: SERMON_DATE ?? null,
        title: VIDEO_TITLE ?? null,
        url: URL,
        gcsPaths: gcsTranscriptUri ? { transcript: gcsTranscriptUri } : {},
        transcriptChars: 0,
        latestSummary: '',
        summarySnapshots: [],
        status: 'capturing',
        capturedAt: new Date().toISOString(),
        kabarId: null,
        createdAt: new Date().toISOString(),
      }, { merge: true });
      console.log(`  ✓ Firestore: registered sermon_captures/${docId} as 'capturing'`);
    } catch (e) {
      console.error('  ✗ Firestore initial write failed:', e instanceof Error ? e.message : e);
    }
  }

  // 1. Gemini Live session — with auto-reconnect on GoAway (code 1008/1011).
  // Gemini Live caps each session at ~10-15 min. Server sends GoAway near the
  // limit; if client doesn't close, server force-closes with 1008. We must
  // detect the close and immediately open a new session — otherwise audio
  // continues piping into a dead socket and the rest of the sermon is lost
  // (observed June 21 2026: ~10 min captured, 80 min lost without reconnect).
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  let geminiSessionCount = 0;

  async function openGeminiSession(): Promise<Session> {
    geminiSessionCount += 1;
    const sessionId = geminiSessionCount;
    return await ai.live.connect({
      model: GEMINI_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: { languageCode: 'id-ID' },
        systemInstruction: TRANSCRIBE_SYSTEM,
      },
      callbacks: {
        onopen: () => console.log(`[gemini] ✓ Live session #${sessionId} open`),
        onmessage: (msg: LiveServerMessage) => {
          const t = msg.serverContent?.inputTranscription?.text;
          if (t) {
            transcript += t;
            process.stdout.write(t);
          }
        },
        onerror: (e: ErrorEvent) => console.error(`\n[gemini #${sessionId}] error:`, e.message),
        onclose: async (e: CloseEvent) => {
          console.log(`\n[gemini #${sessionId}] closed (${e.code}) ${e.reason ?? ''}`);
          // Normal close (1000) when WE finish; otherwise it's a forced close
          // (1008/1011/1013) — reconnect immediately to keep transcribing.
          if (!finished && e.code !== 1000) {
            console.log(`[gemini] reconnecting (session #${sessionId} ended early)…`);
            for (let attempt = 1; attempt <= 5; attempt++) {
              try {
                session = await openGeminiSession();
                return;
              } catch (err) {
                console.error(`[gemini] reconnect attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
                await new Promise(r => setTimeout(r, 1000 * attempt));
              }
            }
            console.error('[gemini] reconnect gave up after 5 attempts');
          }
        },
      },
    });
  }
  session = await openGeminiSession();

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
  // Proxy fallback chain: YouTube bot-detects ALL datacenter IPs at the
  // youtubei/v1/player layer. We use Webshare ROTATING RESIDENTIAL via their
  // backbone gateway p.webshare.io:80 — each session-N username routes to a
  // different residential IP. Even residential has ~40% bot-detect rate, so
  // we iterate sessions until one returns a valid manifest. ffmpeg also goes
  // through the same residential session (manifest URL is IP-tokenized).
  // Source order: backbone session list from API → static PROXIES env → direct.
  let proxyList: string[] = [];
  const webshareToken = process.env.WEBSHARE_TOKEN;
  const WEBSHARE_GATEWAY = process.env.WEBSHARE_GATEWAY ?? 'p.webshare.io:80';
  if (webshareToken) {
    try {
      const r = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&valid=true&page_size=25', {
        headers: { Authorization: `Token ${webshareToken}` },
      });
      if (r.ok) {
        const j = await r.json() as { results: Array<{ proxy_address: string; port: number; username: string; password: string; country_code: string }> };
        // Backbone entries share gateway host:port; only the session-suffixed
        // username (vdjglhjw-N) differs. We encode as "gateway-host:gateway-port:username:password"
        // so downstream parsing stays the same.
        const [gwHost, gwPort] = WEBSHARE_GATEWAY.split(':');
        proxyList = j.results.map(p => `${gwHost}:${gwPort}:${p.username}:${p.password}`);
        console.log(`[proxy] Webshare backbone returned ${proxyList.length} residential sessions via ${WEBSHARE_GATEWAY}`);
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
  // that fetched the manifest.
  //
  // IMPORTANT: ffmpeg's HLS demuxer doesn't reliably propagate http_proxy ENV to
  // segment fetches (each segment is a new HTTP context). We MUST pass -http_proxy
  // as an explicit CLI flag. We also keep the env as belt-and-suspenders.
  const ffmpegEnv = workingProxyUrl
    ? { ...process.env, http_proxy: workingProxyUrl, https_proxy: workingProxyUrl, HTTP_PROXY: workingProxyUrl, HTTPS_PROXY: workingProxyUrl }
    : process.env;
  const proxyArgs = workingProxyUrl ? ['-http_proxy', workingProxyUrl] : [];
  console.log(`[ffmpeg] starting PCM capture${workingProxyUrl ? ' via proxy (-http_proxy + env)' : ' (direct)'}\n`);

  proc = spawn('ffmpeg', [
    ...proxyArgs,
    '-i', m3u8Url, '-vn', '-ar', '16000', '-ac', '1', '-f', 's16le', '-loglevel', 'warning', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv });

  // Surface ffmpeg's HTTP/network warnings (e.g., 403 segment fetches) — silent
  // failures here are exactly what produced 0-byte captures previously.
  proc.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.log(`[ffmpeg-err] ${msg.slice(0, 300)}`);
  });

  // Audio-silent watchdog tracking. ffmpeg keeps emitting PCM bytes even during
  // actual silence (sample-rate × bytes-per-sample is constant). So no stdout for
  // SILENCE_WATCHDOG_MS means ffmpeg is stuck (e.g., HLS manifest dead after stream
  // ended but ffmpeg's retry loop won't exit on its own — observed June 21 service 4).
  let lastAudioReceivedAt = Date.now();
  let firstAudioReceivedAt = 0;

  proc.stdout!.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    lastAudioReceivedAt = Date.now();
    if (!firstAudioReceivedAt) firstAudioReceivedAt = lastAudioReceivedAt;
    try {
      session.sendRealtimeInput({
        audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch { /* drop chunk if session closed */ }
  });

  // 3a. Live transcript snapshot — upload current transcript.txt to GCS every minute
  //     so an admin can peek raw text while sermon is in progress (Phase 2: portal
  //     "Generate Summary Now" button reads from this). No summarization here —
  //     summarization happens ONCE at finalize via Gemini 2.5 Pro.
  const transcriptUploadTimer = setInterval(async () => {
    if (!GCS_BUCKET || transcript.length === 0) return;
    try {
      const localPath = join(OUTPUT_DIR, 'transcript-live.txt');
      writeFileSync(localPath, transcript);
      const remotePath = GCS_PREFIX
        ? `${GCS_PREFIX.replace(/\/$/, '')}/${basename(OUTPUT_DIR)}/transcript.txt`
        : `${basename(OUTPUT_DIR)}/transcript.txt`;
      const storage = new Storage();
      await storage.bucket(GCS_BUCKET).upload(localPath, {
        destination: remotePath,
        contentType: 'text/plain; charset=utf-8',
      });
      const atSec = Math.round((Date.now() - startTime) / 1000);
      console.log(`[transcript] live upload @${atSec}s: ${transcript.length} chars → gs://${GCS_BUCKET}/${remotePath}`);
      // Update Firestore so the portal list view shows the live growing char-count
      if (WRITE_FIRESTORE) {
        try {
          if (!getApps().length) initializeApp({ credential: applicationDefault() });
          const { docId } = computeIdentity();
          await getFirestore().collection('sermon_captures').doc(docId).update({
            transcriptChars: transcript.length,
            lastTranscriptUpdateAt: new Date().toISOString(),
          });
        } catch { /* silent — best-effort live updates */ }
      }
    } catch (e) {
      console.warn(`[transcript] upload failed: ${e instanceof Error ? e.message : e}`);
    }
  }, TRANSCRIPT_UPLOAD_EVERY_MS);

  // 3b. Audio-silent watchdog — finalize early if ffmpeg goes silent
  //     (happens when broadcast ends but ffmpeg doesn't exit; HLS DVR retry loop).
  //     Only triggers AFTER we've received some audio (firstAudioReceivedAt set).
  const silenceCheckTimer = setInterval(() => {
    if (finished || !firstAudioReceivedAt) return;
    const silentMs = Date.now() - lastAudioReceivedAt;
    if (silentMs > SILENCE_WATCHDOG_MS) {
      console.log(`\n[watchdog] no audio for ${Math.round(silentMs / 1000)}s — stream likely ended, finalizing`);
      clearInterval(transcriptUploadTimer);
      clearInterval(silenceCheckTimer);
      finish('audio-silent');
    }
  }, 15_000);

  // 3c. Manual stop check — admin can click "Stop & Summarize" in the portal,
  //     which sets stopRequested=true on the Firestore capture doc. We poll
  //     every 15s and trigger finalize (which runs the Gemini 2.5 Pro summary
  //     on whatever transcript we have so far).
  const stopFlagCheckTimer = WRITE_FIRESTORE ? setInterval(async () => {
    if (finished) return;
    try {
      if (!getApps().length) initializeApp({ credential: applicationDefault() });
      const { docId } = computeIdentity();
      const doc = await getFirestore().collection('sermon_captures').doc(docId).get();
      if (doc.exists && doc.data()?.stopRequested === true) {
        console.log(`\n[stop-flag] admin requested stop via portal — finalizing`);
        clearInterval(transcriptUploadTimer);
        clearInterval(silenceCheckTimer);
        if (stopFlagCheckTimer) clearInterval(stopFlagCheckTimer);
        finish('manual-stop');
      }
    } catch { /* silent — best-effort poll */ }
  }, 15_000) : null;

  // 4a. Auto-stop: STREAM ENDS — ffmpeg exits when the live manifest stops being updated.
  proc.on('exit', (code) => {
    if (finished) return;
    console.log(`\n\n[ffmpeg] exited (code ${code}) — stream ended, finalizing`);
    clearInterval(transcriptUploadTimer);
    clearInterval(silenceCheckTimer);
    if (stopFlagCheckTimer) clearInterval(stopFlagCheckTimer);
    finish('stream-ended');
  });

  // 4b. Hard ceiling — never run longer than MAX_DURATION_MS no matter what
  setTimeout(() => {
    if (finished) return;
    console.log(`\n\n[timer] max duration ${MAX_DURATION_MS / 1000}s reached`);
    clearInterval(transcriptUploadTimer);
    clearInterval(silenceCheckTimer);
    if (stopFlagCheckTimer) clearInterval(stopFlagCheckTimer);
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
    console.log(`\n→ RAW TRANSCRIPT (Gemini 3.1 Live), ${transcript.length} chars`);

    // ── ONE high-quality summary call on the full transcript ──
    let finalSummary = '';
    let finalSummaryModel: string = FINAL_SUMMARY_MODEL;
    if (transcript.length >= 200) {
      console.log(`\n[final-summary] calling ${FINAL_SUMMARY_MODEL} on ${transcript.length} chars...`);
      try {
        finalSummary = await callGeminiFinalSummary(transcript);
        console.log(`[final-summary] ✓ ${finalSummary.length} chars produced`);
      } catch (e) {
        console.error('[final-summary] Gemini Pro failed:', e instanceof Error ? e.message : e);
        try {
          console.log('[final-summary] falling back to ASI1 Mini...');
          finalSummary = await callAsi1Summary(transcript);
          finalSummaryModel = 'asi1-mini-fallback';
          console.log(`[final-summary] ✓ ASI1 fallback ${finalSummary.length} chars`);
        } catch (e2) {
          console.error('[final-summary] ASI1 fallback also failed:', e2 instanceof Error ? e2.message : e2);
        }
      }
    } else {
      console.log('[final-summary] transcript too short, skipping');
    }
    console.log('\n' + '─'.repeat(80));
    console.log('CATATAN KHOTBAH (final)');
    console.log('─'.repeat(80));
    console.log(finalSummary);
    console.log('─'.repeat(80));

    // ── Write local files ──
    writeFileSync(join(OUTPUT_DIR, 'transcript.txt'), transcript);
    writeFileSync(join(OUTPUT_DIR, 'final_summary.md'), finalSummary);
    // summaries.json kept for backward compat with existing to-kabar route which
    // reads `cap.summarySnapshots`. Single-item array containing the final summary.
    const compatSnapshot = finalSummary
      ? [{ atSec: Math.round((Date.now() - startTime) / 1000), summary: finalSummary, transcriptChars: transcript.length }]
      : [];
    writeFileSync(join(OUTPUT_DIR, 'summaries.json'), JSON.stringify(compatSnapshot, null, 2));
    writeFileSync(join(OUTPUT_DIR, 'meta.json'), JSON.stringify({
      url: URL,
      transcriberModel: GEMINI_MODEL,
      summaryModel: finalSummaryModel,
      durationMs: MAX_DURATION_MS,
      actualDurationMs: Date.now() - startTime,
      endReason: reason,
      transcriptChars: transcript.length,
      finalSummaryChars: finalSummary.length,
      finishedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`\nSaved → ${OUTPUT_DIR}/{transcript.txt, final_summary.md, summaries.json, meta.json}`);

    const uploadedPaths: Record<string, string> = {};
    if (GCS_BUCKET) {
      try {
        const storage = new Storage();
        const bucket = storage.bucket(GCS_BUCKET);
        // Upload the four artifacts; transcript.txt now overrides the live one
        // that was being snapshotted every minute during capture (final = same path).
        for (const file of ['transcript.txt', 'final_summary.md', 'summaries.json', 'meta.json']) {
          const localPath = join(OUTPUT_DIR, file);
          const remotePath = GCS_PREFIX
            ? `${GCS_PREFIX.replace(/\/$/, '')}/${basename(OUTPUT_DIR)}/${file}`
            : `${basename(OUTPUT_DIR)}/${file}`;
          const contentType = file.endsWith('.json') ? 'application/json'
            : file.endsWith('.md') ? 'text/markdown; charset=utf-8'
            : 'text/plain; charset=utf-8';
          await bucket.upload(localPath, { destination: remotePath, contentType });
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
        const { docId } = computeIdentity();
        // Merge — preserves the initial "capturing" doc fields (createdAt, kabarId)
        // and the live-updated transcriptChars / lastTranscriptUpdateAt.
        await db.collection('sermon_captures').doc(docId).set({
          gcsPaths: uploadedPaths,
          transcriptChars: transcript.length,
          // Backward-compat fields for /api/sermon-captures/[id]/to-kabar route:
          summarySnapshots: compatSnapshot,
          latestSummary: finalSummary,
          // New fields for the redesigned pipeline:
          finalSummary,
          summaryModel: finalSummaryModel,
          endReason: reason,
          actualDurationMs: Date.now() - startTime,
          status: 'captured',
          finalizedAt: new Date().toISOString(),
        }, { merge: true });
        console.log(`  ✓ Firestore: updated sermon_captures/${docId} → captured`);
      } catch (e) {
        console.error('  ✗ Firestore write failed:', e instanceof Error ? e.message : e);
      }
    }
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', () => finish('sigint'));

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
