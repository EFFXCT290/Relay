// Voice-note transcription: Opus → normalized WAV (ffmpeg) → Whisper JSON →
// structured, per-segment EN/ES-labelled transcript. Speech is preserved
// verbatim and never translated; bilingual code-switching is expected, so each
// segment is classified independently and "mixed" is a first-class label.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../backend-core/runtime/env.js";
import type { Transcript, TranscriptLanguage, TranscriptSegment } from "@relay/contracts";

const exec = promisify(execFile);

// Raw shape emitted by `whisper --output_format json`.
type WhisperJson = {
  text:     string;
  language: string;
  segments: { start: number; end: number; text: string }[];
};

// ── Lightweight EN/ES classifier ──────────────────────────────────────────────
// High-frequency function words are the cheapest reliable signal for short
// utterances; diacritics and inverted punctuation are near-certain Spanish.
const ES_WORDS = new Set([
  "que","de","la","el","los","las","un","una","y","en","es","está","están","estás",
  "esto","eso","pero","como","porque","por","para","con","sin","muy","más","sabes",
  "también","quiero","tengo","hacer","bien","gracias","hola","sí","no","yo","tú",
  "nosotros","ellos","cuando","donde","entonces","ahora","aquí","allá","creo","cosa",
]);
const EN_WORDS = new Set([
  "the","of","and","to","a","in","is","it","you","that","was","for","on","are","with",
  "as","i","be","this","have","from","or","had","by","but","not","what","all","were",
  "we","when","your","can","said","there","do","so","just","know","like","think","really",
]);

function classify(text: string, fallback: TranscriptLanguage): TranscriptLanguage {
  const lower = text.toLowerCase();
  const hasEsGlyph = /[ñáéíóú¿¡]/.test(lower);
  const words = lower.match(/[\p{L}]+/gu) ?? [];

  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  if (hasEsGlyph) es += 2;

  const total = es + en;
  if (total === 0) return fallback;
  const esShare = es / total;
  if (esShare >= 0.65) return "es";
  if (esShare <= 0.35) return "en";
  return "mixed";
}

// Roll segment languages up to one primary label, weighted by text length.
function primaryLanguage(segments: TranscriptSegment[], fallback: TranscriptLanguage): TranscriptLanguage {
  const weight: Record<TranscriptLanguage, number> = { en: 0, es: 0, mixed: 0 };
  for (const s of segments) weight[s.language] += Math.max(s.text.length, 1);
  const en = weight.en;
  const es = weight.es;
  const mixed = weight.mixed;
  if (en + es + mixed === 0) return fallback;
  // Substantial presence of both languages (or explicitly mixed segments) → mixed.
  if (mixed > 0 || (en > 0 && es > 0 && Math.min(en, es) / (en + es) > 0.2)) return "mixed";
  return en >= es ? "en" : "es";
}

// Transcript plus per-stage timings for observability (logged by the worker).
export type TranscribeResult = {
  transcript:   Transcript;
  ffmpegMs:     number;
  transcribeMs: number;
};

/**
 * Transcribe an Opus voice note. `buffer` is the raw uploaded audio. Runs ffmpeg
 * and Whisper as subprocesses in an isolated temp dir that is always cleaned up.
 * Throws on subprocess failure (error carries `.stderr`/`.code`) so the BullMQ
 * job retries and the worker can log the failure detail.
 */
export async function transcribeVoice(buffer: Buffer): Promise<TranscribeResult> {
  const dir = await mkdtemp(join(tmpdir(), "relay-voice-"));
  const inPath  = join(dir, "input.opus");
  const wavPath = join(dir, "audio.wav");
  const jsonPath = join(dir, "audio.json");   // whisper names output after the input stem

  try {
    await writeFile(inPath, buffer);

    // Normalize to mono 16 kHz WAV — Whisper's expected input.
    const ffmpegStart = Date.now();
    await exec(env.FFMPEG_BIN, ["-i", inPath, "-ac", "1", "-ar", "16000", "-y", wavPath, "-loglevel", "error"]);
    const ffmpegMs = Date.now() - ffmpegStart;

    // Auto-detect language (no --language): the recording may be EN, ES, or both;
    // we do our own per-segment labelling afterwards regardless of Whisper's guess.
    const transcribeStart = Date.now();
    await exec(
      env.WHISPER_BIN,
      [
        wavPath,
        "--model", env.WHISPER_MODEL,
        "--task", "transcribe",
        "--output_format", "json",
        "--output_dir", dir,
        "--fp16", "False",
        "--verbose", "False",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const transcribeMs = Date.now() - transcribeStart;

    const raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperJson;
    const detected: TranscriptLanguage = raw.language === "es" ? "es" : "en";

    const segments: TranscriptSegment[] = (raw.segments ?? []).map((s) => {
      const text = s.text.trim();
      return { start: s.start, end: s.end, text, language: classify(text, detected) };
    });

    return {
      transcript: {
        segments,
        fullText:        raw.text.trim(),
        primaryLanguage: primaryLanguage(segments, detected),
      },
      ffmpegMs,
      transcribeMs,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
