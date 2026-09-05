import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, primaryLanguage } from "./voice.transcribe.js";
import type { TranscriptSegment } from "@relay/contracts";

// Pure-function unit tests — no ffmpeg/Whisper subprocess.

describe("classify() — EN/ES lexicon-vote with diacritic bonus", () => {
  it("clear English text classifies 'en'", () => {
    assert.equal(classify("the cat was on the table and it was really nice", "en"), "en");
  });

  it("clear Spanish text classifies 'es'", () => {
    assert.equal(classify("hola como estas yo tengo mucho que hacer pero no se donde", "en"), "es");
  });

  it("a lone word with no lexicon match but an accented glyph is 'es' purely from the diacritic bonus", () => {
    // "café" matches neither word list; hasEsGlyph alone must decide it.
    assert.equal(classify("café", "en"), "es");
  });

  it("an inverted-punctuation-only signal (¿ or ¡) also triggers the diacritic bonus", () => {
    assert.equal(classify("¿zzzqx?", "en"), "es");
  });

  it("no lexicon matches and no diacritics → falls back to the given fallback language", () => {
    assert.equal(classify("zzzqx wibble blorp", "en"), "en");
    assert.equal(classify("zzzqx wibble blorp", "es"), "es");
  });

  it("boundary: esShare exactly 0.65 (13 es / 20 total) classifies 'es' — the >= boundary is inclusive", () => {
    const text = "que ".repeat(13) + "the ".repeat(7);
    assert.equal(classify(text, "en"), "es");
  });

  it("boundary: esShare just below 0.65 (12 es / 20 total = 0.60) classifies 'mixed', not 'es'", () => {
    const text = "que ".repeat(12) + "the ".repeat(8);
    assert.equal(classify(text, "en"), "mixed");
  });

  it("boundary: esShare exactly 0.35 (7 es / 20 total) classifies 'en' — the <= boundary is inclusive", () => {
    const text = "que ".repeat(7) + "the ".repeat(13);
    assert.equal(classify(text, "en"), "en");
  });

  it("boundary: esShare just above 0.35 (8 es / 20 total = 0.40) classifies 'mixed', not 'en'", () => {
    const text = "que ".repeat(8) + "the ".repeat(12);
    assert.equal(classify(text, "en"), "mixed");
  });

  it("an even split (2 es / 2 en) lands in the middle of the mixed band", () => {
    assert.equal(classify("yo tengo the is", "en"), "mixed");
  });
});

describe("primaryLanguage() — length-weighted rollup with the mixed tie-break", () => {
  function seg(text: string, language: TranscriptSegment["language"]): TranscriptSegment {
    return { start: 0, end: 1, text, language };
  }

  it("returns the fallback for an empty segment list", () => {
    assert.equal(primaryLanguage([], "en"), "en");
    assert.equal(primaryLanguage([], "es"), "es");
  });

  it("a single 'mixed' segment forces the overall result to 'mixed', even alongside heavily-weighted en/es segments", () => {
    const segments = [
      seg("x".repeat(1000), "en"),
      seg("y".repeat(1000), "es"),
      seg("z", "mixed"),
    ];
    assert.equal(primaryLanguage(segments, "en"), "mixed");
  });

  it("en clearly dominant by weight → 'en'", () => {
    const segments = [seg("x".repeat(100), "en"), seg("y".repeat(5), "es")];
    assert.equal(primaryLanguage(segments, "en"), "en");
  });

  it("es clearly dominant by weight → 'es'", () => {
    const segments = [seg("x".repeat(5), "en"), seg("y".repeat(100), "es")];
    assert.equal(primaryLanguage(segments, "en"), "es");
  });

  it("boundary: min/sum exactly 0.2 (en=80, es=20) is NOT mixed — the tie-break is a strict > — falls through to en>=es → 'en'", () => {
    const segments = [seg("e".repeat(80), "en"), seg("s".repeat(20), "es")];
    assert.equal(primaryLanguage(segments, "en"), "en");
  });

  it("boundary: min/sum just above 0.2 (en=79, es=21 → 0.21) IS mixed", () => {
    const segments = [seg("e".repeat(79), "en"), seg("s".repeat(21), "es")];
    assert.equal(primaryLanguage(segments, "en"), "mixed");
  });

  it("only 'en' segments present (es weight is 0) → 'en' regardless of the tie-break ratio", () => {
    const segments = [seg("hello", "en"), seg("world", "en")];
    assert.equal(primaryLanguage(segments, "es"), "en");
  });

  it("only 'es' segments present (en weight is 0) → 'es'", () => {
    const segments = [seg("hola", "es"), seg("mundo", "es")];
    assert.equal(primaryLanguage(segments, "en"), "es");
  });

  it("an empty-text segment still counts as weight 1 for its language (Math.max(length,1))", () => {
    const segments = [seg("", "es")];
    assert.equal(primaryLanguage(segments, "en"), "es");
  });
});
