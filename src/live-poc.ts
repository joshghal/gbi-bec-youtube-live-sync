/**
 * Live YouTube stream → Gemini Live API → rolling transcript/summary.
 *
 * Pipeline:
 *   yt-dlp (live audio) → ffmpeg (resample to 16kHz PCM mono) → WebSocket → Gemini Live
 *                                                                         ↓
 *                                                                 incremental text out
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx src/live-poc.ts <youtube-live-url>
 *   GEMINI_API_KEY=... npx tsx src/live-poc.ts https://www.youtube.com/watch?v=LuKwFajn37U
 */
import 'dotenv/config';
import { spawn, ChildProcess } from 'node:child_process';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

const URL = process.argv[2];
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-native-audio-latest';
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS ?? '600000', 10); // default 10 min POC cap
const SUMMARY_EVERY_MS = parseInt(process.env.SUMMARY_EVERY_MS ?? '90000', 10);  // print rolling status every 90s

if (!URL || !KEY) {
  console.error('Usage: GEMINI_API_KEY=... npx tsx src/live-poc.ts <youtube-live-url>');
  console.error('Optional env: GEMINI_MODEL, MAX_DURATION_MS, SUMMARY_EVERY_MS');
  process.exit(1);
}

const SYSTEM_INSTRUCTION = `Kamu adalah transcriber & summarizer real-time untuk video live YouTube (bisa podcast, berita, atau ceramah).

TUGAS:
1. Transkripkan apa yang dibicarakan dalam bahasa aslinya (jangan terjemahkan).
2. Output transkrip secara incremental — setelah setiap 1-2 kalimat yang sudah lengkap, emit langsung. Jangan menunggu jeda panjang.
3. Format: tulis hanya transkrip mentah. JANGAN tambahkan label "[Speaker 1]" atau timestamp.
4. Jika ada perubahan topik yang signifikan, awali dengan baris kosong.

JANGAN beri komentar, ringkasan, atau analisis sendiri. Hanya transkrip mentah.`;

let session: Session;
const audioBacklog: string[] = []; // base64 chunks queued while WS warms up
let wsReady = false;
let transcriptChars = 0;
let lastEmitAt = Date.now();
let proc: ChildProcess | null = null;

async function main() {
  console.log(`[live] URL: ${URL}`);
  console.log(`[live] Model: ${MODEL}`);
  console.log(`[live] Max duration: ${MAX_DURATION_MS / 1000}s`);
  console.log('');

  const ai = new GoogleGenAI({ apiKey: KEY });

  session = await ai.live.connect({
    model: MODEL,
    config: {
      // Live "native-audio" models output AUDIO; we ignore it and use the
      // inputAudioTranscription stream instead — that's the text transcription
      // of what's being SPOKEN in our input audio.
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: { languageCode: 'id-ID' },  // pin language to fix Devanagari artifact
      systemInstruction: SYSTEM_INSTRUCTION,
    },
    callbacks: {
      onopen: () => {
        wsReady = true;
        console.log('[live] ✓ Gemini Live WebSocket open');
        while (audioBacklog.length) {
          const chunk = audioBacklog.shift()!;
          session.sendRealtimeInput({
            media: { data: chunk, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      },
      onmessage: (msg: LiveServerMessage) => {
        // Input transcription = real-time text of the audio we sent in
        const inputText = msg.serverContent?.inputTranscription?.text;
        if (inputText) {
          process.stdout.write(inputText);
          transcriptChars += inputText.length;
          lastEmitAt = Date.now();
        }
        // Discard any modelTurn audio output (we don't need it)
        if (msg.serverContent?.turnComplete) {
          process.stdout.write('\n');
        }
      },
      onerror: (e: ErrorEvent) => {
        console.error('\n[live] ✗ WebSocket error:', e.message);
      },
      onclose: (e: CloseEvent) => {
        console.log(`\n[live] WebSocket closed (code ${e.code}): ${e.reason}`);
      },
    },
  });

  // Live YouTube streams don't expose audio-only formats — they're HLS muxed.
  // Get the lowest-bitrate HLS manifest, then ffmpeg consumes + discards video.
  console.log('[live] Resolving m3u8 manifest…');
  const m3u8Url = await new Promise<string>((resolve, reject) => {
    const yt = spawn('yt-dlp', ['--no-update', '--quiet', '--no-warnings', '-f', '91', '--get-url', URL!]);
    let out = '';
    yt.stdout.on('data', (d) => out += d.toString());
    yt.on('exit', (code) => code === 0 && out.trim() ? resolve(out.trim().split('\n')[0]) : reject(new Error(`yt-dlp exit ${code}`)));
  });
  console.log(`[live] ✓ manifest acquired (${m3u8Url.slice(0, 60)}…)\n`);

  proc = spawn('ffmpeg', [
    '-i', m3u8Url,
    '-vn',                  // discard video
    '-ar', '16000',         // 16 kHz
    '-ac', '1',             // mono
    '-f', 's16le',          // 16-bit little-endian PCM
    '-loglevel', 'error',
    '-',                    // stdout
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('[live] ✓ ffmpeg streaming PCM\n');

  let totalBytes = 0;
  proc.stdout!.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    const b64 = chunk.toString('base64');
    if (wsReady) {
      session.sendRealtimeInput({
        media: { data: b64, mimeType: 'audio/pcm;rate=16000' },
      });
    } else {
      audioBacklog.push(b64);
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const txt = chunk.toString();
    // Surface unexpected errors (suppress routine progress)
    if (txt.match(/error|fail/i)) console.error('[ffmpeg]', txt.trim().slice(0, 200));
  });

  proc.on('exit', (code) => {
    console.log(`\n[live] yt-dlp/ffmpeg exited (code ${code}). Audio bytes: ${(totalBytes / 1024).toFixed(1)} KB`);
    shutdown();
  });

  // Periodic status
  setInterval(() => {
    const upMs = Date.now() - startTime;
    const sinceLastEmit = (Date.now() - lastEmitAt) / 1000;
    console.log(`\n──── status @ ${(upMs / 1000).toFixed(0)}s ── audio: ${(totalBytes / 1024).toFixed(1)} KB · transcript: ${transcriptChars} chars · idle: ${sinceLastEmit.toFixed(0)}s ────\n`);
  }, SUMMARY_EVERY_MS);

  // Auto-stop
  setTimeout(() => {
    console.log(`\n[live] Reached MAX_DURATION_MS — shutting down`);
    shutdown();
  }, MAX_DURATION_MS);
}

const startTime = Date.now();

function shutdown() {
  try { proc?.kill('SIGTERM'); } catch { /* noop */ }
  try { session?.close(); } catch { /* noop */ }
  const upS = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[live] Final: ${upS}s elapsed, ${transcriptChars} transcript chars`);
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => {
  console.log('\n[live] SIGINT — shutting down');
  shutdown();
});

main().catch((err) => {
  console.error('[live] Fatal:', err);
  process.exit(1);
});
