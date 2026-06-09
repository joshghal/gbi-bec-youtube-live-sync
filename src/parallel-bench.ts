/**
 * A/B benchmark: two Gemini 3.1 Live sessions, same model, same audio,
 * differ ONLY in inputAudioTranscription.languageCode setting.
 *
 *   A = baseline:  inputAudioTranscription: {}                      (auto-detect)
 *   B = modified:  inputAudioTranscription: { languageCode: 'id-ID' }
 *
 * Tests the hypothesis from adversarial review: pinning languageCode='id-ID'
 * fixes the Devanagari/script-mixing artifact observed in earlier Indonesian runs.
 *
 * Also logs usage_metadata (input audio tokens, output tokens) so we can compare
 * real $ cost, not vibes.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx src/parallel-bench.ts <youtube-live-url>
 */
import 'dotenv/config';
import { spawn, ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

const URL = process.argv[2];
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-live-preview';
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS ?? '180000', 10);

if (!URL || !KEY) {
  console.error('Usage: GEMINI_API_KEY=... npx tsx src/parallel-bench.ts <youtube-live-url>');
  process.exit(1);
}

const VARIANTS = [
  { id: 'A', label: 'baseline (no languageCode)', langCode: undefined },
  { id: 'B', label: "modified (languageCode='id-ID')", langCode: 'id-ID' as const },
];

interface Runner {
  id: string;
  label: string;
  langCode?: string;
  session: Session;
  transcript: string;
  charsRecvd: number;
  errors: string[];
  ready: boolean;
  promptTokens: number;
  responseTokens: number;
  // Devanagari + other non-Latin/Indonesian-script script detection
  nonLatinChars: number;
  scriptArtifacts: string[];
}

const SYSTEM = `Kamu adalah real-time transcriber untuk video live YouTube berbahasa Indonesia. Transkripkan apa yang dibicarakan secara incremental. Output hanya teks transkrip, tanpa komentar.`;

// Devanagari, Arabic, Hangul, CJK, Cyrillic blocks — any of these in an Indonesian
// transcript = a script-detection failure (the bug we're trying to fix).
const NON_INDO_SCRIPT_RE = /[ऀ-ॿ؀-ۿ가-힯一-鿿Ѐ-ӿ぀-ヿ]/g;

async function startVariant(ai: GoogleGenAI, v: typeof VARIANTS[number]): Promise<Runner> {
  const runner: Runner = {
    id: v.id,
    label: v.label,
    langCode: v.langCode,
    transcript: '',
    charsRecvd: 0,
    errors: [],
    ready: false,
    promptTokens: 0,
    responseTokens: 0,
    nonLatinChars: 0,
    scriptArtifacts: [],
    session: undefined as unknown as Session,
  };

  const inputAudioTranscription = v.langCode
    ? { languageCode: v.langCode }
    : {};

  runner.session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription,
      systemInstruction: SYSTEM,
    },
    callbacks: {
      onopen: () => {
        runner.ready = true;
        console.log(`[${v.id}] ✓ connected — ${v.label}`);
      },
      onmessage: (msg: LiveServerMessage) => {
        const t = msg.serverContent?.inputTranscription?.text;
        if (t) {
          runner.transcript += t;
          runner.charsRecvd += t.length;
          // Surveille script-mixing artifacts in real-time
          const matches = t.match(NON_INDO_SCRIPT_RE);
          if (matches) {
            runner.nonLatinChars += matches.length;
            runner.scriptArtifacts.push(t.replace(/^\s+|\s+$/g, '').slice(0, 80));
          }
        }
        // usage_metadata logging (change #3)
        const u = (msg as unknown as { usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
        if (u) {
          if (typeof u.promptTokenCount === 'number') runner.promptTokens = u.promptTokenCount;
          if (typeof u.responseTokenCount === 'number') runner.responseTokens = u.responseTokenCount;
        }
      },
      onerror: (e: ErrorEvent) => {
        runner.errors.push(e.message);
        console.error(`[${v.id}] ✗ error: ${e.message}`);
      },
      onclose: (e: CloseEvent) => {
        console.log(`[${v.id}] closed (${e.code}) ${e.reason ?? ''}`);
        runner.ready = false;
      },
    },
  });

  return runner;
}

async function main() {
  console.log(`URL:      ${URL}`);
  console.log(`Model:    ${MODEL}`);
  console.log(`Duration: ${MAX_DURATION_MS / 1000}s`);
  console.log(`Variants:`);
  VARIANTS.forEach((v) => console.log(`  [${v.id}] ${v.label}`));
  console.log();

  const ai = new GoogleGenAI({ apiKey: KEY });
  const runners = await Promise.all(VARIANTS.map((v) => startVariant(ai, v)));

  console.log('[bench] Resolving m3u8…');
  const m3u8Url = await new Promise<string>((resolve, reject) => {
    const yt = spawn('yt-dlp', ['--no-update', '--quiet', '--no-warnings', '-f', '91', '--get-url', URL!]);
    let out = '';
    yt.stdout.on('data', (d) => out += d.toString());
    yt.on('exit', (code) => code === 0 && out.trim() ? resolve(out.trim().split('\n')[0]) : reject(new Error(`yt-dlp exit ${code}`)));
  });

  console.log('[bench] Starting ffmpeg PCM capture\n');
  const proc: ChildProcess = spawn('ffmpeg', [
    '-i', m3u8Url, '-vn', '-ar', '16000', '-ac', '1', '-f', 's16le', '-loglevel', 'error', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let totalBytes = 0;
  proc.stdout!.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    const b64 = chunk.toString('base64');
    for (const r of runners) {
      if (r.ready) {
        try {
          r.session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
        } catch (e) {
          r.errors.push(String(e));
        }
      }
    }
  });

  const startTime = Date.now();
  const statusTimer = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\n── @${elapsed}s · audio ${(totalBytes / 1024).toFixed(0)} KB ──`);
    runners.forEach((r) => {
      console.log(`  [${r.id}] chars=${r.charsRecvd}  errors=${r.errors.length}  non-latin=${r.nonLatinChars}  tokens(p/r)=${r.promptTokens}/${r.responseTokens}`);
    });
  }, 30000);

  await new Promise<void>((resolve) => setTimeout(resolve, MAX_DURATION_MS));

  console.log('\n[bench] Duration reached, finalizing…');
  clearInterval(statusTimer);
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 3000));
  for (const r of runners) {
    try { r.session.close(); } catch { /* noop */ }
  }

  console.log('\n' + '='.repeat(80));
  console.log('A/B BENCHMARK — Gemini 3.1 Live with vs without languageCode');
  console.log('='.repeat(80));
  runners.forEach((r) => {
    console.log(`\n[${r.id}] ${r.label}`);
    console.log(`    transcript: ${r.charsRecvd} chars, errors: ${r.errors.length}`);
    console.log(`    non-Indonesian script chars: ${r.nonLatinChars}`);
    console.log(`    usage tokens — prompt: ${r.promptTokens}, response: ${r.responseTokens}`);
    if (r.scriptArtifacts.length) {
      console.log(`    SCRIPT ARTIFACTS detected (${r.scriptArtifacts.length}):`);
      r.scriptArtifacts.slice(0, 5).forEach((a) => console.log(`      → ${a}`));
    }
    console.log(`    transcript preview:`);
    console.log(r.transcript.slice(0, 1000).split(/(.{1,90})/).filter(Boolean).map((l) => '      ' + l).join('\n'));
  });

  // Save artifacts
  runners.forEach((r) => {
    writeFileSync(`/tmp/bench-langcode-${r.id}.txt`, r.transcript);
  });
  writeFileSync('/tmp/bench-langcode-stats.json', JSON.stringify(
    runners.map((r) => ({
      variant: r.id,
      label: r.label,
      langCode: r.langCode,
      chars: r.charsRecvd,
      nonLatinChars: r.nonLatinChars,
      scriptArtifacts: r.scriptArtifacts,
      promptTokens: r.promptTokens,
      responseTokens: r.responseTokens,
      errors: r.errors,
    })),
    null, 2));

  console.log('\nSaved → /tmp/bench-langcode-{A,B}.txt + /tmp/bench-langcode-stats.json');
  process.exit(0);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
