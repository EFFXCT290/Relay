import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/web/public/sw.js is a plain script that runs in a ServiceWorkerGlobalScope
// (`self`), not an ES module — it can't be `import`ed. No Playwright (or any
// other real-browser/service-worker harness) exists anywhere in this repo yet
// (checked before writing this). Standing one up JUST for this one file's few
// event handlers would be a large, disproportionate investment — Playwright
// itself, browser binaries, a service-worker-capable test fixture — for logic
// that doesn't actually need real rendering or a real SW lifecycle to verify.
//
// Instead: load the script's actual source text into a `new Function("self",
// source)` and call it with a fake `self` whose addEventListener just records
// handlers by event name. This runs the REAL, unmodified sw.js logic (not a
// reimplementation of it) and lets tests invoke its handlers directly with
// synthetic events — enough for everything this cluster asks for: the
// notificationclick focus-or-open + deep-link behavior, the
// pushsubscriptionchange re-subscribe flow, and the tag-based collapse
// logic's own showNotification call shape.
//
// What this deliberately does NOT (and per the coverage plan, cannot) verify:
// whether a real browser actually REPLACES a same-tag notification when
// renotify:true is set — sw.js's own comment already self-flags that iOS
// 16.4+ can silently drop a renotify instead of replacing it, and that "real
// device behavior remains unverified" (not fixed here, not claimed as tested).
const swPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../public/sw.js");
const swSource = fs.readFileSync(swPath, "utf-8");

type Listener = (event: unknown) => void;

function makeEvent(overrides: Record<string, unknown> = {}) {
  let waited: Promise<unknown> | undefined;
  return {
    waitUntil: (p: Promise<unknown>) => {
      waited = p;
    },
    __getWaited: () => waited,
    ...overrides,
  };
}

function createFakeSelf() {
  const listeners: Record<string, Listener[]> = {};
  const showNotification = vi.fn(async (_title?: string, _options?: { tag?: string; renotify?: boolean }) => {});
  const getNotifications = vi.fn(async () => [] as Array<{ close: () => void }>);
  const matchAll = vi.fn(async () => [] as unknown[]);
  const openWindow = vi.fn(async () => {});
  const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: "https://push.example/ep" }) }));
  const skipWaiting = vi.fn();
  const claim = vi.fn(async () => {});

  const fakeSelf = {
    location: { href: "https://relay.example/sw.js?api=https%3A%2F%2Fapi.relay.example" },
    addEventListener: (type: string, handler: Listener) => {
      (listeners[type] ??= []).push(handler);
    },
    skipWaiting,
    clients: { claim, matchAll, openWindow },
    registration: { showNotification, getNotifications, pushManager: { subscribe } },
  };

  return { fakeSelf, listeners, showNotification, getNotifications, matchAll, openWindow, subscribe, skipWaiting, claim };
}

function loadSw(fakeSelf: unknown) {
  const fn = new Function("self", swSource);
  fn(fakeSelf);
}

function getHandler(listeners: Record<string, Listener[]>, type: string): Listener {
  const handler = listeners[type]?.[0];
  if (!handler) throw new Error(`sw.js never registered a "${type}" listener`);
  return handler;
}

describe("sw.js — notificationclick: focus an existing tab or open a new one, deep-linking correctly", () => {
  it("an existing Relay tab is focused and navigated to the notification's deep link — no new window opened", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onClick = getHandler(env.listeners, "notificationclick");

    const client = { focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
    env.matchAll.mockResolvedValue([client]);

    const notification = { close: vi.fn(), data: { url: "/conversations/abc123" } };
    const event = makeEvent({ notification });
    onClick(event);
    await event.__getWaited();

    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.navigate).toHaveBeenCalledWith("/conversations/abc123");
    expect(env.openWindow).not.toHaveBeenCalled();
  });

  it("with no matching open tab, opens a new window at the deep link instead", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onClick = getHandler(env.listeners, "notificationclick");

    env.matchAll.mockResolvedValue([]);
    const notification = { close: vi.fn(), data: { url: "/conversations/xyz789" } };
    const event = makeEvent({ notification });
    onClick(event);
    await event.__getWaited();

    expect(env.openWindow).toHaveBeenCalledWith("/conversations/xyz789");
  });

  it("falls back to /conversations when the notification carries no url", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onClick = getHandler(env.listeners, "notificationclick");

    env.matchAll.mockResolvedValue([]);
    const notification = { close: vi.fn(), data: null };
    const event = makeEvent({ notification });
    onClick(event);
    await event.__getWaited();

    expect(env.openWindow).toHaveBeenCalledWith("/conversations");
  });

  it("a focused client without a .navigate method (cross-origin/older client) is left focused, not crashed, and no new window opens", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onClick = getHandler(env.listeners, "notificationclick");

    const client = { focus: vi.fn(async () => {}) }; // deliberately no `navigate`
    env.matchAll.mockResolvedValue([client]);

    const notification = { close: vi.fn(), data: { url: "/conversations/abc123" } };
    const event = makeEvent({ notification });
    expect(() => onClick(event)).not.toThrow();
    await event.__getWaited();

    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(env.openWindow).not.toHaveBeenCalled();
  });
});

describe("sw.js — pushsubscriptionchange: re-subscribes and re-registers with the API", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("re-subscribes with the old subscription's applicationServerKey and POSTs the new subscription to the API", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onChange = getHandler(env.listeners, "pushsubscriptionchange");

    const fakeKey = new Uint8Array([1, 2, 3]);
    const event = makeEvent({ oldSubscription: { options: { applicationServerKey: fakeKey } } });
    onChange(event);
    await event.__getWaited();

    expect(env.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: fakeKey });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.relay.example/api/push/subscribe");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(init.body)).toEqual({ endpoint: "https://push.example/ep" });
  });

  it("with no oldSubscription info at all, still re-subscribes (key undefined) rather than throwing", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onChange = getHandler(env.listeners, "pushsubscriptionchange");

    const event = makeEvent({ oldSubscription: null });
    expect(() => onChange(event)).not.toThrow();
    await event.__getWaited();

    expect(env.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed re-subscribe is swallowed (best-effort) — does not throw, does not call fetch", async () => {
    const env = createFakeSelf();
    env.subscribe.mockRejectedValueOnce(new Error("permission revoked"));
    loadSw(env.fakeSelf);
    const onChange = getHandler(env.listeners, "pushsubscriptionchange");

    const event = makeEvent({ oldSubscription: null });
    expect(() => onChange(event)).not.toThrow();
    await event.__getWaited();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sw.js — tag-based collapse logic against synthetic push payloads", () => {
  it("two pushes sharing the same tag both request collapse (renotify:true, same tag) — real same-tag replacement is the browser's job, not verified here", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onPush = getHandler(env.listeners, "push");

    for (const body of ["first", "second"]) {
      const event = makeEvent({ data: { json: () => ({ title: "Alice", body, tag: "conversation-conv-1", url: "/conversations/conv-1" }) } });
      onPush(event);
      await event.__getWaited();
    }

    expect(env.showNotification).toHaveBeenCalledTimes(2);
    for (const call of env.showNotification.mock.calls) {
      const options = call[1] as { tag?: string; renotify?: boolean };
      expect(options.tag).toBe("conversation-conv-1");
      expect(options.renotify).toBe(true);
    }
  });

  it("a push with no tag does not request collapse (renotify:false, tag:undefined) — stacks instead", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onPush = getHandler(env.listeners, "push");

    const event = makeEvent({ data: { json: () => ({ title: "Alice", body: "hi" }) } });
    onPush(event);
    await event.__getWaited();

    const options = env.showNotification.mock.calls[0]![1] as { tag?: string; renotify?: boolean };
    expect(options.tag).toBeUndefined();
    expect(options.renotify).toBe(false);
  });

  it('a "call_cleared" payload closes the existing same-tag notification(s) instead of showing a new one', async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onPush = getHandler(env.listeners, "push");

    const stale = { close: vi.fn() };
    env.getNotifications.mockResolvedValue([stale]);

    const event = makeEvent({ data: { json: () => ({ type: "call_cleared", tag: "call-xyz" }) } });
    onPush(event);
    await event.__getWaited();

    expect(env.getNotifications).toHaveBeenCalledWith({ tag: "call-xyz" });
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(env.showNotification).not.toHaveBeenCalled();
  });

  it("malformed (non-JSON) push data falls back to sane defaults instead of throwing", async () => {
    const env = createFakeSelf();
    loadSw(env.fakeSelf);
    const onPush = getHandler(env.listeners, "push");

    const event = makeEvent({
      data: {
        json: () => {
          throw new Error("not json");
        },
      },
    });
    expect(() => onPush(event)).not.toThrow();
    await event.__getWaited();

    expect(env.showNotification).toHaveBeenCalledWith("Relay", expect.objectContaining({ body: "" }));
  });
});
