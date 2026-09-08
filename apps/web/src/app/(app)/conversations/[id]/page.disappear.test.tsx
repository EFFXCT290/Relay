import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@relay/contracts";
import { MESSAGE_EVENTS } from "@relay/contracts";

// Disappearing-messages live-update coverage for ChatThreadPage — same real
// component + fake socket + fake api() transport harness as page.test.tsx
// (duplicated per this codebase's convention of not sharing test scaffolding
// across files). Covers: the explicit-open modal for both modes, the
// sender's live progress/started ticks, live removal via the existing
// message:deleted broadcast, and — the actual regression this file exists to
// guard — that a message:deleted broadcast racing in right after a
// last-look open can no longer hide the content that open already
// delivered (see page.tsx's openDisappear / handleViewDisappear).

const CONV_ID = "11111111-1111-1111-1111-111111111111";
const ME_ID = "22222222-2222-2222-2222-222222222222";
const PARTNER_ID = "33333333-3333-3333-3333-333333333333";

const routerStub = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: CONV_ID }),
  useRouter: () => routerStub,
}));

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
  private dispatch(event: string, payload?: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(payload);
  }
  simulateMessageDeleted(payload: { messageId: string; conversationId?: string }): void {
    this.dispatch("message:deleted", payload);
  }
  simulateDisappearProgress(payload: {
    messageId: string;
    conversationId: string;
    viewCount: number;
    viewLimit: number;
    consumed: boolean;
    viewedAt: string;
  }): void {
    this.dispatch(MESSAGE_EVENTS.DISAPPEAR_PROGRESS, payload);
  }
  simulateDisappearStarted(payload: { messageId: string; conversationId: string; expiresAt: string }): void {
    this.dispatch(MESSAGE_EVENTS.DISAPPEAR_STARTED, payload);
  }
}

let fakeSocket: FakeSocket;
vi.mock("@/frontend-core/socket", () => ({
  getSocket: () => fakeSocket,
  getReconnectEpoch: () => fakeSocket.epoch,
}));

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
    myAcceptedAt: new Date().toISOString(),
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
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });

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
      return { messages: [...initialMessages].reverse(), nextCursor: null };
    }
    if (path === `/api/conversations/${CONV_ID}/read` && method === "POST") return undefined;
    if (path === `/api/conversations/${CONV_ID}/pins` && method === "GET") return { pins: [] };
    throw new Error(`renderPage's default apiImpl doesn't handle: ${method} ${path}`);
  };
  const view = render(<ChatThreadPage />);
  await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument());
  return view;
}

describe("ChatThreadPage — disappearing messages: views mode modal", () => {
  it("tapping a locked card opens the modal with the revealed body", async () => {
    const locked = makeMessage({
      messageId: "msg-locked",
      body: null,
      disappear: { mode: "views", viewLimit: 3, viewCount: 0, expiresAt: null },
    });
    await renderPage([locked]);
    const user = userEvent.setup();

    expect(await screen.findByRole("button", { name: /Tap to view/ })).toBeInTheDocument();

    apiImpl = async (path, opts) => {
      if (path === "/api/messages/msg-locked/view" && opts?.method === "POST") {
        return { mode: "views", consumed: false, viewCount: 1, viewLimit: 3, body: "peekaboo" };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    await user.click(screen.getByRole("button", { name: /Tap to view/ }));

    await waitFor(() => expect(screen.getByText("peekaboo")).toBeInTheDocument());
    // The card itself is still locked (this is the modal, not an inline reveal).
    expect(screen.getByRole("button", { name: /Tap to view/ })).toBeInTheDocument();

    // Closing the modal doesn't affect the card's own live viewCount tick.
    await user.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(screen.queryByText("peekaboo")).not.toBeInTheDocument());
  });

  it("REGRESSION: a message:deleted broadcast racing in right after the last-look open does not hide the content that open already delivered", async () => {
    // This is exactly the mechanism behind the bug report: on the LAST look,
    // the server emits message:deleted essentially concurrently with
    // returning the HTTP response containing the revealed body. If the
    // socket event were processed before the HTTP response resolved (or, as
    // modeled here, arrives immediately after), a naive implementation that
    // re-reads messagesRef[messageId].body for the modal would show nothing
    // — the recipient's own successful last look would go unseen. The fix is
    // that the modal displays a SNAPSHOT from the response, independent of
    // messagesRef entirely.
    const locked = makeMessage({
      messageId: "msg-lastlook",
      body: null,
      disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null },
    });
    await renderPage([locked]);
    const user = userEvent.setup();

    const openGate = deferred<{ mode: string; consumed: boolean; viewCount: number; viewLimit: number; body: string }>();
    apiImpl = async (path, opts) => {
      if (path === "/api/messages/msg-lastlook/view" && opts?.method === "POST") return openGate.promise;
      throw new Error(`unexpected call: ${path}`);
    };

    await user.click(screen.getByRole("button", { name: /Tap to view/ }));

    // The live delete broadcast arrives BEFORE the HTTP response resolves —
    // the exact ordering that would break a messagesRef-derived modal.
    act(() => {
      fakeSocket.simulateMessageDeleted({ messageId: "msg-lastlook", conversationId: CONV_ID });
    });
    // The card is gone / tombstoned now — confirms the race really did land
    // ahead of the response, not just theoretically.
    await waitFor(() => expect(screen.getByText("Message deleted")).toBeInTheDocument());

    // NOW the HTTP response finally resolves with the content that was, in
    // fact, successfully spent.
    await act(async () => {
      openGate.resolve({ mode: "views", consumed: true, viewCount: 1, viewLimit: 1, body: "the last look" });
      await openGate.promise;
    });

    // The recipient must still see what they opened, despite the tombstone
    // already having landed in the list.
    await waitFor(() => expect(screen.getByText("the last look")).toBeInTheDocument());
  });
});

describe("ChatThreadPage — disappearing messages: time mode modal", () => {
  it("tapping a not-yet-started card opens the modal with the body and starts the clock", async () => {
    const notStarted = makeMessage({
      messageId: "msg-timed",
      body: null,
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: null },
    });
    await renderPage([notStarted]);
    const user = userEvent.setup();

    expect(await screen.findByText("Tap to open")).toBeInTheDocument();

    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    apiImpl = async (path, opts) => {
      if (path === "/api/messages/msg-timed/view" && opts?.method === "POST") {
        return { mode: "time", body: "a timed secret", expiresAt };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    await user.click(screen.getByText("Tap to open"));
    await waitFor(() => expect(screen.getByText("a timed secret")).toBeInTheDocument());
    expect(screen.getByText(/Disappears in 5m/)).toBeInTheDocument();

    // Closing then reopening the card now shows "Tap to view · Xleft"
    // instead of "Tap to open" — the clock visibly started.
    await user.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(screen.getByText(/Tap to view · 5m left/)).toBeInTheDocument());
  });

  it("message:disappear:started ticks the sender's card live, without opening anything", async () => {
    const mine = makeMessage({
      messageId: "msg-mine-timed",
      senderId: ME_ID,
      body: null,
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: null },
    });
    await renderPage([mine]);

    expect(await screen.findByText("Waiting to be opened")).toBeInTheDocument();

    act(() => {
      fakeSocket.simulateDisappearStarted({
        messageId: "msg-mine-timed",
        conversationId: CONV_ID,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    });

    await waitFor(() => expect(screen.getByText(/Disappearing in 1h/)).toBeInTheDocument());
  });

  it("the existing message:deleted broadcast removes a swept time-mode message live, for either participant", async () => {
    const timed = makeMessage({
      messageId: "msg-swept",
      senderId: ME_ID,
      body: null,
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    await renderPage([timed]);
    expect(await screen.findByText(/Disappearing in/)).toBeInTheDocument();

    act(() => {
      fakeSocket.simulateMessageDeleted({ messageId: "msg-swept", conversationId: CONV_ID });
    });

    await waitFor(() => expect(screen.queryByText(/Disappearing in/)).not.toBeInTheDocument());
    expect(await screen.findByText("Message deleted")).toBeInTheDocument();
  });
});

describe("ChatThreadPage — disappearing messages: views-mode progress ticks the sender's card", () => {
  it("message:disappear:progress ticks the sender's status line live, without revealing any text", async () => {
    const mine = makeMessage({
      messageId: "msg-mine",
      senderId: ME_ID,
      body: null,
      disappear: { mode: "views", viewLimit: 2, viewCount: 0, expiresAt: null },
    });
    await renderPage([mine]);

    expect(await screen.findByText("2 views")).toBeInTheDocument();
    expect(screen.queryByText(/Opened/)).not.toBeInTheDocument();

    act(() => {
      fakeSocket.simulateDisappearProgress({
        messageId: "msg-mine",
        conversationId: CONV_ID,
        viewCount: 1,
        viewLimit: 2,
        consumed: false,
        viewedAt: new Date().toISOString(),
      });
    });

    await waitFor(() => expect(screen.getByText(/Opened 1\/2/)).toBeInTheDocument());
  });
});
