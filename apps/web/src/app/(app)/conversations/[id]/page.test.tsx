import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message, ReplayResponse } from "@relay/contracts";
import { SYNC_EVENTS } from "@relay/contracts";

// ChatThreadPage is the most complex piece of frontend code in the coverage
// plan: refs-based normalized message store (not React state, for O(1)
// swaps), a real Socket.IO connection, and the sync-barrier reconnect-replay
// logic whose "failed replay silently treated as fully synced" bug was just
// fixed. This drives the REAL component through a fake socket + fake api()
// transport rather than re-testing the fix at the unit level again.

const CONV_ID = "11111111-1111-1111-1111-111111111111";
const ME_ID = "22222222-2222-2222-2222-222222222222";
const PARTNER_ID = "33333333-3333-3333-3333-333333333333";

// ── next/navigation ──────────────────────────────────────────────────────────
// useRouter() MUST return a stable reference — page.tsx's initial-load effect
// depends on `router`, so a fresh object literal per call (an easy mock
// mistake) makes that effect re-fire on every render, re-triggering the
// initial detail/history fetch against whatever apiImpl a later test step
// has since swapped in.
const routerStub = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: CONV_ID }),
  useRouter: () => routerStub,
}));

// ── providers ────────────────────────────────────────────────────────────────
vi.mock("@/providers/me-provider", () => ({
  useMe: () => ({ userId: ME_ID }),
}));
vi.mock("@/features/calls/call-provider", () => ({
  useCall: () => ({
    state: { phase: "idle" },
    startCall: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    toggleMute: vi.fn(),
    toggleCamera: vi.fn(),
    switchCamera: vi.fn(),
  }),
}));

// ── fake socket ──────────────────────────────────────────────────────────────
type Listener = (...args: unknown[]) => void;

class FakeSocket {
  connected = true;
  epoch = 0;
  private listeners = new Map<string, Set<Listener>>();
  emitLog: Array<{ event: string; payload: unknown }> = [];

  emit(event: string, payload?: unknown): void {
    this.emitLog.push({ event, payload });
  }
  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
  emitCallsFor(event: string) {
    return this.emitLog.filter((e) => e.event === event);
  }
  private dispatch(event: string, payload?: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(payload);
  }
  // Server-push simulation helpers, used by tests:
  simulateConnect(): void {
    this.epoch++; // mirrors socket.ts's own real reconnectEpoch++ listener
    this.dispatch("connect");
  }
  simulateMessageNew(message: Message): void {
    this.dispatch("message:new", { message });
  }
  simulateReplayResponse(res: ReplayResponse): void {
    this.dispatch(SYNC_EVENTS.REPLAY_RESPONSE, res);
  }
}

let fakeSocket: FakeSocket;
vi.mock("@/frontend-core/socket", () => ({
  getSocket: () => fakeSocket,
  getReconnectEpoch: () => fakeSocket.epoch,
}));

// ── fake api() transport (real ApiError class preserved) ────────────────────
let apiImpl: (path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { method?: string; body?: unknown }) => apiImpl(path, opts) };
});

function makeDetail() {
  return {
    conversationId: CONV_ID,
    participant: { userId: PARTNER_ID, username: "partner", isOnline: true, lastSeenAt: null },
    createdAt: new Date().toISOString(),
    myAcceptedAt: new Date().toISOString(), // non-null so ChatComposer renders, not AcceptCard
  };
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    messageId: overrides.messageId ?? crypto.randomUUID(),
    conversationId: CONV_ID,
    senderId: overrides.senderId ?? PARTNER_ID,
    senderUsername: "partner",
    type: "TEXT",
    body: "hello",
    replyTo: null,
    isEdited: false,
    editedAt: null,
    isDeleted: false,
    reactions: {},
    myReaction: null,
    readBy: [],
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// jsdom has no ResizeObserver (a long-standing gap) — stub it so
// @tanstack/react-virtual's .observe() call doesn't throw.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// @tanstack/react-virtual's OWN initial measurement (virtual-core's getRect())
// reads element.offsetWidth/offsetHeight directly — NOT getBoundingClientRect
// — and jsdom hardcodes both to 0 (no real layout engine). Without this, the
// virtualizer computes a permanently empty visible range regardless of
// overscan: every message row would silently fail to render, with no error
// anywhere. This one prototype stub fixes it for every element, once, for
// the whole file — no per-test reset needed since it doesn't affect any
// assertion.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });

// jsdom also has no scrollTo implementation — the jump-to-bottom button calls
// el.scrollTo({ top, behavior: "smooth" }), which would throw without this.
if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, opts?: ScrollToOptions | number) {
    if (typeof opts === "object" && opts !== null && typeof opts.top === "number") {
      this.scrollTop = opts.top;
    }
  };
}

// Sets the scroll metrics the page's scroll handler reads (el.scrollHeight /
// el.clientHeight / el.scrollTop) — jsdom has no layout engine, so these are
// all 0 by default and must be defined per-test to simulate a given
// scroll position.
function setScrollMetrics(el: HTMLElement, opts: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: opts.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: opts.clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: opts.scrollTop });
}

// @tanstack/react-virtual attaches its OWN native 'scroll' listener to the
// same element and, on a real (non-zero) scrollHeight/clientHeight change,
// schedules a 150ms-debounced "isScrolling" reset via a raw window.setTimeout
// it never exposes a way to cancel. If a test ends and unmounts (afterEach's
// cleanup()) before that fires, the timer still fires later for real,
// against an unmounted tree — a stray cross-test error. Waiting it out here,
// while the component is still mounted, lets it settle harmlessly.
async function flushVirtualizerDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

let ChatThreadPage: typeof import("./page").default;

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  fakeSocket = new FakeSocket();
  apiImpl = async (path) => {
    throw new Error(`unexpected api() call in this test: ${path}`);
  };
  vi.resetModules();
  ChatThreadPage = (await import("./page")).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPage(initialMessages: Message[] = []) {
  apiImpl = async (path: string, opts?: { method?: string; body?: unknown }) => {
    const method = opts?.method ?? "GET";
    if (path === `/api/conversations/${CONV_ID}` && method === "GET") return makeDetail();
    if (path.startsWith(`/api/conversations/${CONV_ID}/messages?`) && method === "GET") {
      return { messages: [...initialMessages].reverse(), nextCursor: null }; // API is newest-first
    }
    if (path === `/api/conversations/${CONV_ID}/read` && method === "POST") return undefined;
    if (path === `/api/conversations/${CONV_ID}/pins` && method === "GET") return { pins: [] };
    // ContactInfoModal fetches this on mount for the Info Card's media count.
    if (path.startsWith(`/api/conversations/${CONV_ID}/media?`) && method === "GET") {
      return { items: [], nextCursor: null, totalCount: 0 };
    }
    throw new Error(`renderPage's default apiImpl doesn't handle: ${method} ${path}`);
  };
  const view = render(<ChatThreadPage />);
  await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument());
  return view;
}

describe("ChatThreadPage — optimistic send: tempId → realId swap", () => {
  it("shows the message immediately (optimistic), then swaps to the server id with no duplicate once the POST resolves", async () => {
    await renderPage([]);
    const user = userEvent.setup();

    const sendGate = deferred<Message>();
    apiImpl = async (path, opts) => {
      if (path === `/api/conversations/${CONV_ID}/messages` && opts?.method === "POST") {
        return sendGate.promise;
      }
      throw new Error(`unexpected call during send: ${path}`);
    };

    const textarea = screen.getByPlaceholderText("Message…");
    await user.type(textarea, "hi there{Enter}");

    // Optimistic bubble appears BEFORE the server has responded at all.
    // Scoped to `div` — the composer's own textarea still holds "hi there"
    // as its value until handleSend's promise resolves (ChatComposer only
    // clears it after `await onSend(...)` finishes), which is unrelated to
    // the thing under test here.
    expect(await screen.findByText("hi there", { selector: "div" })).toBeInTheDocument();
    expect(screen.getAllByText("hi there", { selector: "div" })).toHaveLength(1);

    // Server confirms with a different, real messageId.
    const realMessage = makeMessage({ messageId: "real-message-id", senderId: ME_ID, body: "hi there" });
    await act(async () => {
      sendGate.resolve(realMessage);
      await sendGate.promise;
    });

    await waitFor(() => {
      expect(screen.getAllByText("hi there", { selector: "div" })).toHaveLength(1); // swapped, not duplicated
    });
  });
});

describe("ChatThreadPage — dedup on WS echo of your own optimistic send", () => {
  it("when the WS echo (matching clientMessageId) arrives BEFORE the HTTP response, the HTTP response causes no duplicate", async () => {
    await renderPage([]);
    const user = userEvent.setup();

    const sendGate = deferred<Message>();
    let sentClientMessageId: string | undefined;
    apiImpl = async (path, opts) => {
      if (path === `/api/conversations/${CONV_ID}/messages` && opts?.method === "POST") {
        sentClientMessageId = (opts.body as { clientMessageId: string }).clientMessageId;
        return sendGate.promise;
      }
      throw new Error(`unexpected call: ${path}`);
    };

    const textarea = screen.getByPlaceholderText("Message…");
    await user.type(textarea, "race me{Enter}");
    expect(await screen.findByText("race me", { selector: "div" })).toBeInTheDocument();

    await waitFor(() => expect(sentClientMessageId).toBeDefined());

    // WS echo arrives first (Case B in handleSend's own comment): the
    // atomic tempId swap happens via applyMessageNew, not the HTTP path.
    const echoed = makeMessage({
      messageId: "real-message-id",
      senderId: ME_ID,
      body: "race me",
      clientMessageId: sentClientMessageId,
    });
    act(() => fakeSocket.simulateMessageNew(echoed));

    await waitFor(() => {
      expect(screen.getAllByText("race me", { selector: "div" })).toHaveLength(1);
    });

    // The HTTP response finally resolves too — must be a no-op, not a
    // second insertion (Case B: "tempId is already gone ... nothing to do").
    await act(async () => {
      sendGate.resolve(echoed);
      await sendGate.promise;
    });

    expect(screen.getAllByText("race me", { selector: "div" })).toHaveLength(1);
  });
});

describe("ChatThreadPage — sync-barrier ordering on reconnect replay", () => {
  it("a failed socket replay does NOT flush the barrier as if successful; the HTTP fallback's events are applied first, then the buffered live event, in order", async () => {
    const existing = makeMessage({ messageId: "msg-0", body: "already here", createdAt: "2026-01-01T00:00:00.000Z" });
    await renderPage([existing]);

    // The HTTP fallback is manually gated so its resolution point is fully
    // deterministic — act()'s microtask draining otherwise makes it
    // impossible to reliably observe "in flight, not yet resolved" using a
    // bare `await Promise.resolve()` race.
    const fallbackGate = deferred<{ events: ReplayResponse["events"]; nextCursor: string | null }>();
    apiImpl = async (path, opts) => {
      if (path === "/api/sync/replay" && opts?.method === "POST") return fallbackGate.promise;
      if (path === `/api/conversations/${CONV_ID}/read` && opts?.method === "POST") return undefined;
      throw new Error(`unexpected call: ${path}`);
    };

    // Reconnect — opens the sync barrier and requests a socket-side replay.
    act(() => fakeSocket.simulateConnect());
    await waitFor(() => expect(fakeSocket.emitCallsFor(SYNC_EVENTS.REPLAY_REQUEST).length).toBeGreaterThan(0));

    // A LIVE message arrives while the barrier is open — must be buffered,
    // not applied yet.
    const liveMessage = makeMessage({ messageId: "msg-2", body: "live while syncing", createdAt: "2026-01-01T00:02:00.000Z" });
    act(() => fakeSocket.simulateMessageNew(liveMessage));
    expect(screen.queryByText("live while syncing", { selector: "div" })).not.toBeInTheDocument();

    // The socket-side replay FAILS — this must NOT be treated as "fully
    // synced" just because nextCursor is null (the bug that was fixed). The
    // HTTP fallback call is now in flight but deliberately held open.
    act(() => {
      fakeSocket.simulateReplayResponse({ events: [], nextCursor: null, error: "simulated outbox failure" });
    });

    // Still mid-recovery — the fallback hasn't resolved yet, so the barrier
    // must still be closed: neither the buffered live message nor anything
    // from the (not-yet-answered) fallback has leaked through.
    expect(screen.queryByText("live while syncing", { selector: "div" })).not.toBeInTheDocument();
    expect(screen.queryByText("recovered via http fallback", { selector: "div" })).not.toBeInTheDocument();

    // Now let the HTTP fallback resolve with the actually-missed message —
    // this must land, and only THEN does the buffered live message flush.
    await act(async () => {
      fallbackGate.resolve({
        events: [
          {
            eventId: "evt-1",
            eventName: "message:new",
            payload: { message: makeMessage({ messageId: "msg-1", body: "recovered via http fallback", createdAt: "2026-01-01T00:01:00.000Z" }) },
            timestamp: "2026-01-01T00:01:00.000Z",
          },
        ],
        nextCursor: null,
      });
      await fallbackGate.promise;
    });

    await waitFor(() => expect(screen.getByText("recovered via http fallback", { selector: "div" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("live while syncing", { selector: "div" })).toBeInTheDocument());

    // Causal order: pre-existing (msg-0) → recovered (msg-1) → the buffered
    // live message (msg-2), all in DOM order.
    const elExisting  = screen.getByText(existing.body!, { selector: "div" });
    const elRecovered = screen.getByText("recovered via http fallback", { selector: "div" });
    const elLive      = screen.getByText("live while syncing", { selector: "div" });
    expect(elExisting.compareDocumentPosition(elRecovered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(elRecovered.compareDocumentPosition(elLive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("ChatThreadPage — header avatar/name opens Contact info", () => {
  it("clicking the header avatar/name block opens ContactInfoModal (same surface the ⋯ menu's 'Contact info' item opens)", async () => {
    await renderPage();
    const user = userEvent.setup();

    expect(screen.queryByRole("dialog", { name: "Contact info" })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Contact info for @partner"));
    expect(screen.getByRole("dialog", { name: "Contact info" })).toBeInTheDocument();
  });

  it("also opens from the ⋯ menu's 'Contact info' item, into the exact same dialog — one surface, two triggers", async () => {
    await renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("More"));
    await user.click(screen.getByText("Contact info"));
    expect(screen.getByRole("dialog", { name: "Contact info" })).toBeInTheDocument();
  });
});

describe("ChatThreadPage — infinite scroll-up reentrancy", () => {
  it("fires exactly one fetch for the older-messages page, even when a fast scroll-up delivers a burst of 'scroll' events before the loading-state update commits", async () => {
    const newer = makeMessage({ messageId: "msg-newer", body: "newer message", createdAt: "2026-01-01T00:05:00.000Z" });
    const older = makeMessage({ messageId: "msg-older", body: "older message", createdAt: "2026-01-01T00:00:00.000Z" });

    let olderPageCallCount = 0;
    const olderPageGate = deferred<{ messages: Message[]; nextCursor: string | null }>();

    apiImpl = async (path, opts) => {
      const method = opts?.method ?? "GET";
      if (path === `/api/conversations/${CONV_ID}` && method === "GET") return makeDetail();
      // Initial history load — establishes nextCursor so loadOlder becomes eligible.
      if (path === `/api/conversations/${CONV_ID}/messages?limit=30` && method === "GET") {
        return { messages: [newer], nextCursor: "cursor-1" };
      }
      // loadOlder's page fetch — held open (deferred) so overlapping calls are observable.
      if (path === `/api/conversations/${CONV_ID}/messages?limit=30&cursor=cursor-1` && method === "GET") {
        olderPageCallCount++;
        return olderPageGate.promise;
      }
      if (path === `/api/conversations/${CONV_ID}/read` && method === "POST") return undefined;
      if (path === `/api/conversations/${CONV_ID}/pins` && method === "GET") return { pins: [] };
      if (path.startsWith(`/api/conversations/${CONV_ID}/media?`) && method === "GET") {
        return { items: [], nextCursor: null, totalCount: 0 };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const { container } = render(<ChatThreadPage />);
    await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument());
    await screen.findByText("newer message", { selector: "div" });

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();

    // A fast trackpad/scroll-up gesture delivers several native 'scroll'
    // events synchronously — all dispatched before React has a chance to
    // commit the loadingOlder state flip from the first one, so they all
    // land on the same (stale) listener closure.
    act(() => {
      Object.defineProperty(scrollEl, "scrollTop", { configurable: true, writable: true, value: 10 });
      fireEvent.scroll(scrollEl!);
      fireEvent.scroll(scrollEl!);
      fireEvent.scroll(scrollEl!);
    });

    await waitFor(() => expect(olderPageCallCount).toBeGreaterThan(0));
    expect(olderPageCallCount).toBe(1); // one page fetch, not three, despite the scroll burst

    await act(async () => {
      olderPageGate.resolve({ messages: [older], nextCursor: null });
      await olderPageGate.promise;
    });
  });
});

describe("ChatThreadPage — jump-to-bottom affordance", () => {
  it("shows the button once scrolled away from the bottom, and hides it again once scrolled back", async () => {
    const msg = makeMessage({ messageId: "msg-1", body: "hello", createdAt: "2026-01-01T00:00:00.000Z" });
    const { container } = await renderPage([msg]);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLElement;

    expect(screen.queryByRole("button", { name: "Jump to latest messages" })).not.toBeInTheDocument();

    act(() => {
      setScrollMetrics(scrollEl, { scrollHeight: 2000, clientHeight: 600, scrollTop: 0 }); // 1400px from bottom
      fireEvent.scroll(scrollEl);
    });
    expect(screen.getByRole("button", { name: "Jump to latest messages" })).toBeInTheDocument();

    act(() => {
      setScrollMetrics(scrollEl, { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 }); // back at the bottom
      fireEvent.scroll(scrollEl);
    });
    expect(screen.queryByRole("button", { name: "Jump to latest messages" })).not.toBeInTheDocument();
    await flushVirtualizerDebounce();
  });

  it("shows an unseen-count badge for a partner message that arrives while scrolled up, but not one that arrives while already at the bottom", async () => {
    const msg = makeMessage({ messageId: "msg-1", body: "hello", createdAt: "2026-01-01T00:00:00.000Z" });
    const { container } = await renderPage([msg]);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLElement;

    // Already at the bottom (default state) — a partner message shouldn't
    // surface the button/badge at all, since nothing was missed.
    act(() => {
      fakeSocket.simulateMessageNew(makeMessage({
        messageId: "msg-seen", body: "seen already", senderId: PARTNER_ID, createdAt: "2026-01-01T00:01:00.000Z",
      }));
    });
    await screen.findByText("seen already", { selector: "div" });
    expect(screen.queryByRole("button", { name: "Jump to latest messages" })).not.toBeInTheDocument();

    // Scroll away from the bottom.
    act(() => {
      setScrollMetrics(scrollEl, { scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
      fireEvent.scroll(scrollEl);
    });
    expect(screen.getByRole("button", { name: "Jump to latest messages" })).toBeInTheDocument();

    // A partner message arrives while scrolled up — badge appears with count 1.
    act(() => {
      fakeSocket.simulateMessageNew(makeMessage({
        messageId: "msg-missed-1", body: "missed 1", senderId: PARTNER_ID, createdAt: "2026-01-01T00:02:00.000Z",
      }));
    });
    expect(await screen.findByRole("button", { name: "1 new message — jump to latest" })).toBeInTheDocument();

    // A second one increments it.
    act(() => {
      fakeSocket.simulateMessageNew(makeMessage({
        messageId: "msg-missed-2", body: "missed 2", senderId: PARTNER_ID, createdAt: "2026-01-01T00:03:00.000Z",
      }));
    });
    expect(await screen.findByRole("button", { name: "2 new messages — jump to latest" })).toBeInTheDocument();
    await flushVirtualizerDebounce();
  });

  it("tapping the button smooth-scrolls to the bottom and clears the button/badge", async () => {
    const msg = makeMessage({ messageId: "msg-1", body: "hello", createdAt: "2026-01-01T00:00:00.000Z" });
    const { container } = await renderPage([msg]);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLElement;
    const scrollToSpy = vi.spyOn(scrollEl, "scrollTo");

    act(() => {
      setScrollMetrics(scrollEl, { scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
      fireEvent.scroll(scrollEl);
    });
    act(() => {
      fakeSocket.simulateMessageNew(makeMessage({
        messageId: "msg-missed", body: "missed", senderId: PARTNER_ID, createdAt: "2026-01-01T00:02:00.000Z",
      }));
    });
    const button = await screen.findByRole("button", { name: "1 new message — jump to latest" });

    const user = userEvent.setup();
    await user.click(button);

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    expect(screen.queryByRole("button", { name: /jump to latest/ })).not.toBeInTheDocument();
    await flushVirtualizerDebounce();
  });
});

describe("ChatThreadPage — header identity block loading shape", () => {
  it("shows an avatar-circle + 2-line skeleton in the header before conversation detail loads", () => {
    apiImpl = () => new Promise(() => {}); // never resolves — keeps `detail` null
    const { container } = render(<ChatThreadPage />);

    const header = container.querySelector("header")!;
    expect(header).toBeTruthy();
    expect(header.querySelectorAll(".animate-pulse.rounded-full")).toHaveLength(1); // avatar circle
    expect(header.querySelectorAll(".animate-pulse:not(.rounded-full)")).toHaveLength(2); // 2 text lines
  });
});

describe("ChatThreadPage — loading-older skeleton shape", () => {
  it("shows 2 stacked bubble-shaped skeleton placeholders (not text) while fetching an older page", async () => {
    const newer = makeMessage({ messageId: "msg-newer", body: "newer message", createdAt: "2026-01-01T00:05:00.000Z" });
    const older = makeMessage({ messageId: "msg-older", body: "older message", createdAt: "2026-01-01T00:00:00.000Z" });

    const olderPageGate = deferred<{ messages: Message[]; nextCursor: string | null }>();
    apiImpl = async (path, opts) => {
      const method = opts?.method ?? "GET";
      if (path === `/api/conversations/${CONV_ID}` && method === "GET") return makeDetail();
      if (path === `/api/conversations/${CONV_ID}/messages?limit=30` && method === "GET") {
        return { messages: [newer], nextCursor: "cursor-1" };
      }
      if (path === `/api/conversations/${CONV_ID}/messages?limit=30&cursor=cursor-1` && method === "GET") {
        return olderPageGate.promise;
      }
      if (path === `/api/conversations/${CONV_ID}/read` && method === "POST") return undefined;
      if (path === `/api/conversations/${CONV_ID}/pins` && method === "GET") return { pins: [] };
      if (path.startsWith(`/api/conversations/${CONV_ID}/media?`) && method === "GET") {
        return { items: [], nextCursor: null, totalCount: 0 };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const { container } = render(<ChatThreadPage />);
    await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument());
    await screen.findByText("newer message", { selector: "div" });

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLElement;
    act(() => {
      Object.defineProperty(scrollEl, "scrollTop", { configurable: true, writable: true, value: 10 });
      fireEvent.scroll(scrollEl);
    });

    await waitFor(() => expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0));

    const pulses = container.querySelectorAll(".animate-pulse");
    expect(pulses).toHaveLength(2); // exactly 2 bubble placeholders
    for (const p of pulses) expect(p.className).not.toContain("rounded-full"); // bubble shapes, not avatars
    expect(screen.queryByText("loading older")).not.toBeInTheDocument();

    await act(async () => {
      olderPageGate.resolve({ messages: [older], nextCursor: null });
      await olderPageGate.promise;
    });
  });
});
