import { describe, it } from "node:test";
import assert from "node:assert/strict";

// isNotificationProviderEnabled() parses NOTIFICATION_PROVIDER (a CSV env
// var) into a Set ONCE, at env.ts's module-load time — it's not a function
// with parameters we can call differently per case. To exercise each CSV
// edge case for real, set process.env.NOTIFICATION_PROVIDER and do a fresh,
// cache-busted import of env.ts before each check, then restore the real
// value so later code in this same process (if any) sees it unchanged.
// env.ts has no other cross-import state to worry about (unlike
// calls.runtime.ts elsewhere in this suite) — each fresh import is a clean,
// independent re-parse.
async function isEnabledFor(csv: string, provider: "discord" | "push"): Promise<boolean> {
  const prev = process.env.NOTIFICATION_PROVIDER;
  process.env.NOTIFICATION_PROVIDER = csv;
  try {
    const url = new URL("./env.ts", import.meta.url).href + `?t=${Math.random()}`;
    const mod = await import(url);
    return mod.isNotificationProviderEnabled(provider) as boolean;
  } finally {
    if (prev === undefined) delete process.env.NOTIFICATION_PROVIDER;
    else process.env.NOTIFICATION_PROVIDER = prev;
  }
}

describe("isNotificationProviderEnabled() — NOTIFICATION_PROVIDER CSV parsing", () => {
  it("empty string: both providers disabled", async () => {
    assert.equal(await isEnabledFor("", "discord"), false);
    assert.equal(await isEnabledFor("", "push"), false);
  });

  it("single value: only that provider is enabled", async () => {
    assert.equal(await isEnabledFor("discord", "discord"), true);
    assert.equal(await isEnabledFor("discord", "push"), false);
    assert.equal(await isEnabledFor("push", "push"), true);
    assert.equal(await isEnabledFor("push", "discord"), false);
  });

  it("both values: both providers enabled", async () => {
    assert.equal(await isEnabledFor("discord,push", "discord"), true);
    assert.equal(await isEnabledFor("discord,push", "push"), true);
  });

  it("surrounding whitespace around values is trimmed", async () => {
    assert.equal(await isEnabledFor(" discord , push ", "discord"), true);
    assert.equal(await isEnabledFor(" discord , push ", "push"), true);
    assert.equal(await isEnabledFor("  discord  ", "discord"), true);
  });

  it("a whitespace-only value is filtered out (not treated as a truthy garbage entry)", async () => {
    assert.equal(await isEnabledFor("   ", "discord"), false);
    assert.equal(await isEnabledFor("   ", "push"), false);
  });

  it("unknown/garbage provider names are harmless — never match discord or push, and don't break parsing of the real values alongside them", async () => {
    assert.equal(await isEnabledFor("slack", "discord"), false);
    assert.equal(await isEnabledFor("slack", "push"), false);
    assert.equal(await isEnabledFor("discord,slack", "discord"), true);
    assert.equal(await isEnabledFor("discord,slack", "push"), false);
  });

  it("empty segments from doubled/leading/trailing commas are dropped, not treated as garbage entries", async () => {
    assert.equal(await isEnabledFor(",,", "discord"), false);
    assert.equal(await isEnabledFor(",,", "push"), false);
    assert.equal(await isEnabledFor("discord,,push", "discord"), true);
    assert.equal(await isEnabledFor("discord,,push", "push"), true);
    assert.equal(await isEnabledFor(",discord,", "discord"), true);
    assert.equal(await isEnabledFor(",discord,", "push"), false);
  });

  it("a whitespace-only segment between two real values is dropped cleanly", async () => {
    assert.equal(await isEnabledFor("discord,   ,push", "discord"), true);
    assert.equal(await isEnabledFor("discord,   ,push", "push"), true);
  });

  it("matching is case-sensitive: differently-cased values do not match (documents actual behavior — not asserting this is desirable, just verified)", async () => {
    assert.equal(await isEnabledFor("Discord,PUSH", "discord"), false);
    assert.equal(await isEnabledFor("Discord,PUSH", "push"), false);
  });

  it("the documented default (\"discord,push\") enables both", async () => {
    assert.equal(await isEnabledFor("discord,push", "discord"), true);
    assert.equal(await isEnabledFor("discord,push", "push"), true);
  });
});
