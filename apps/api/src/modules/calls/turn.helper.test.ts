import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { generateTurnCredentials, turnHost } from "./turn.helper.js";
import { env } from "../../backend-core/runtime/env.js";

// Pure-function unit tests — no Fastify, no DB, no real TURN server. `env` is a
// plain mutable object at runtime (its `as const` is TS-only, not
// Object.freeze), so TURN_URL/TURN_SECRET are set/restored per test below to
// exercise both the configured and STUN-only branches without touching
// process.env or re-importing the module.
function withTurnEnv<T>(turnUrl: string, turnSecret: string, fn: () => T): T {
  const prevUrl = env.TURN_URL;
  const prevSecret = env.TURN_SECRET;
  (env as { TURN_URL: string }).TURN_URL = turnUrl;
  (env as { TURN_SECRET: string }).TURN_SECRET = turnSecret;
  try {
    return fn();
  } finally {
    (env as { TURN_URL: string }).TURN_URL = prevUrl;
    (env as { TURN_SECRET: string }).TURN_SECRET = prevSecret;
  }
}

describe("turn.helper.ts — generateTurnCredentials", () => {
  it("is deterministic: same userId + same expiry second → identical username/credential", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    withTurnEnv("turn.example.com", "shared-secret", () => {
      const userId = randomUUID();
      const a = generateTurnCredentials(userId);
      const b = generateTurnCredentials(userId);
      assert.equal(a.username, b.username);
      assert.equal(a.credential, b.credential);
    });
  });

  it("a different userId changes both username and credential (same instant)", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    withTurnEnv("turn.example.com", "shared-secret", () => {
      const a = generateTurnCredentials(randomUUID());
      const b = generateTurnCredentials(randomUUID());
      assert.notEqual(a.username, b.username);
      assert.notEqual(a.credential, b.credential);
    });
  });

  it("a different expiry (clock tick) changes both username and credential (same userId)", (t) => {
    const userId = randomUUID();
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const a = withTurnEnv("turn.example.com", "shared-secret", () => generateTurnCredentials(userId));
    t.mock.timers.tick(1000); // advance the clock by 1s → different expiry second
    const b = withTurnEnv("turn.example.com", "shared-secret", () => generateTurnCredentials(userId));
    assert.notEqual(a.username, b.username);
    assert.notEqual(a.credential, b.credential);
  });

  it("credential is exactly base64(HMAC-SHA1(secret, username)) — matches an independent computation", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    withTurnEnv("turn.example.com", "shared-secret", () => {
      const userId = randomUUID();
      const creds = generateTurnCredentials(userId);
      const expected = createHmac("sha1", "shared-secret").update(creds.username).digest("base64");
      assert.equal(creds.credential, expected);
    });
  });

  it("mints an expiry ~24h (86400s) out from now, not some other TTL", () => {
    withTurnEnv("turn.example.com", "shared-secret", () => {
      const before = Date.now();
      const creds = generateTurnCredentials(randomUUID());
      const after = Date.now();

      const expiry = Number(creds.username.split(":")[0]);
      const minExpected = Math.floor(before / 1000) + 24 * 60 * 60;
      const maxExpected = Math.floor(after / 1000) + 24 * 60 * 60;
      assert.ok(
        expiry >= minExpected && expiry <= maxExpected,
        `expiry ${expiry} should land within [${minExpected}, ${maxExpected}] (~24h from now)`,
      );
    });
  });

  it("embeds the userId verbatim after the expiry in the username", () => {
    withTurnEnv("turn.example.com", "shared-secret", () => {
      const userId = randomUUID();
      const creds = generateTurnCredentials(userId);
      assert.equal(creds.username, `${creds.username.split(":")[0]}:${userId}`);
    });
  });

  it("STUN-only fallback when TURN_URL and TURN_SECRET are both unconfigured", () => {
    withTurnEnv("", "", () => {
      const creds = generateTurnCredentials(randomUUID());
      assert.equal(creds.username, "");
      assert.equal(creds.credential, "");
      assert.equal(creds.iceServers.length, 1);
      assert.equal(creds.iceServers[0]!.urls, "stun:stun.l.google.com:19302");
      assert.equal((creds.iceServers[0] as { username?: string }).username, undefined);
    });
  });

  it("STUN-only fallback when only TURN_URL is set (no secret to sign with)", () => {
    withTurnEnv("turn.example.com", "", () => {
      const creds = generateTurnCredentials(randomUUID());
      assert.equal(creds.username, "");
      assert.equal(creds.credential, "");
      assert.equal(creds.iceServers.length, 1);
    });
  });

  it("STUN-only fallback when only TURN_SECRET is set (no host to relay through)", () => {
    withTurnEnv("", "shared-secret", () => {
      const creds = generateTurnCredentials(randomUUID());
      assert.equal(creds.username, "");
      assert.equal(creds.credential, "");
      assert.equal(creds.iceServers.length, 1);
    });
  });

  it("fully configured: returns STUN + TURN, with the TURN entry carrying udp/tcp/tls variants", () => {
    withTurnEnv("turn.example.com", "shared-secret", () => {
      const creds = generateTurnCredentials(randomUUID());
      assert.equal(creds.iceServers.length, 2);
      assert.equal(creds.iceServers[0]!.urls, "stun:stun.l.google.com:19302");

      const turn = creds.iceServers[1]!;
      assert.deepEqual(turn.urls, [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turns:turn.example.com:5349?transport=tcp",
      ]);
      assert.equal((turn as { username?: string }).username, creds.username);
      assert.equal((turn as { credential?: string }).credential, creds.credential);
    });
  });
});

describe("turn.helper.ts — turnHost()", () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: "bare host", input: "turn.example.com", expected: "turn.example.com" },
    { name: "turns:// scheme + port", input: "turns://turn.example.com:5349", expected: "turn.example.com" },
    { name: "turn: scheme (no slashes) + port", input: "turn:turn.example.com:3478", expected: "turn.example.com" },
    { name: "stun: scheme", input: "stun:stun.example.com", expected: "stun.example.com" },
    { name: "bare host + port, no scheme", input: "turn.example.com:3478", expected: "turn.example.com" },
    { name: "path and query string", input: "turn.example.com/path?query=1", expected: "turn.example.com" },
    { name: "scheme + port + path + query all together", input: "turns://turn.example.com:5349/relay?x=1", expected: "turn.example.com" },
    { name: "surrounding whitespace", input: "  turn.example.com  ", expected: "turn.example.com" },
    { name: "empty string", input: "", expected: "" },
    { name: "bare IPv4 host + port", input: "203.0.113.5:3478", expected: "203.0.113.5" },
  ];

  for (const { name, input, expected } of cases) {
    it(`strips down to the bare host: ${name}`, () => {
      assert.equal(turnHost(input), expected);
    });
  }
});
