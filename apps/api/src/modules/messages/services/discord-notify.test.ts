import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { maybeNotifyDiscord } from "./discord-notify.js";

// maybeNotifyDiscord reads DISCORD_WEBHOOK_URL/DISCORD_ALERT_USER_ID from
// process.env at CALL time (not import time — see its own comment), so
// setting/restoring them directly around each test is sufficient; no module
// mock needed for the env side. The outgoing webhook POST itself is captured
// via a real fetch mock (same t.mock.method(globalThis, "fetch", ...)
// pattern as spotify.service.test.ts) rather than asserting maybeNotifyDiscord
// was merely called with the right opts — this exercises the actual JSON
// body that would reach Discord.
const ALERT_UID = "alert-user-id";
let originalWebhook: string | undefined;
let originalAlertUid: string | undefined;

before(() => {
  originalWebhook = process.env.DISCORD_WEBHOOK_URL;
  originalAlertUid = process.env.DISCORD_ALERT_USER_ID;
  process.env.DISCORD_WEBHOOK_URL = "https://discord.example/webhook";
  process.env.DISCORD_ALERT_USER_ID = ALERT_UID;
});

after(() => {
  if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
  if (originalAlertUid === undefined) delete process.env.DISCORD_ALERT_USER_ID;
  else process.env.DISCORD_ALERT_USER_ID = originalAlertUid;
});

const log = { info() {} };

describe("maybeNotifyDiscord() — disappearing-message placeholder wording", () => {
  it("a disappearing message (body already redacted to null by the caller) uses the sender-aware placeholder, not the generic '(message)' label", async (t) => {
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: { body: string }) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return { status: 204 } as Response;
    });

    await maybeNotifyDiscord({
      senderUsername: "alice",
      body: null,
      messageType: "TEXT",
      recipientIds: [ALERT_UID],
      onlineIds: [],
      isDisappearing: true,
      log,
    });

    assert.equal(fetchCalls.length, 1);
    const embed = (fetchCalls[0]!.body as { embeds: [{ description: string }] }).embeds[0];
    assert.equal(embed.description, "alice sent a disappearing message");
  });

  it("uses the alert user's own nickname override for the sender when one is supplied", async (t) => {
    const fetchCalls: Array<{ body: unknown }> = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
      fetchCalls.push({ body: JSON.parse(init.body) });
      return { status: 204 } as Response;
    });

    await maybeNotifyDiscord({
      senderUsername: "alice",
      body: null,
      messageType: "TEXT",
      recipientIds: [ALERT_UID],
      onlineIds: [],
      isDisappearing: true,
      senderDisplayNames: new Map([[ALERT_UID, "Boss"]]),
      log,
    });

    const embed = (fetchCalls[0]!.body as { embeds: [{ description: string }] }).embeds[0];
    assert.equal(embed.description, "Boss sent a disappearing message");
  });

  it("a normal (non-disappearing) message is unaffected — real preview text still goes through", async (t) => {
    const fetchCalls: Array<{ body: unknown }> = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
      fetchCalls.push({ body: JSON.parse(init.body) });
      return { status: 204 } as Response;
    });

    await maybeNotifyDiscord({
      senderUsername: "alice",
      body: "hey there",
      messageType: "TEXT",
      recipientIds: [ALERT_UID],
      onlineIds: [],
      log,
    });

    const embed = (fetchCalls[0]!.body as { embeds: [{ description: string }] }).embeds[0];
    assert.equal(embed.description, "hey there");
  });
});
