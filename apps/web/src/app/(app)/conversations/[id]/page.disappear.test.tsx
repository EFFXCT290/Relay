import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@relay/contracts";
import { MESSAGE_EVENTS } from "@relay/contracts";

// Disappearing-messages live-update coverage for ChatThreadPage — same real
// component + fake socket + fake api() transport harness as page.test.tsx
// (duplicated per this codebase's convention of not sharing test scaffolding
// across files). Covers: views-mode reveal via POST /view, the sender's
// progress tick via message:disappear:progress, and live removal for BOTH
// modes via the existing message:deleted broadcast — the same event every
// other soft-delete path already uses.

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

describe("ChatThreadPage — disappearing messages: views mode", () => {
  it("tapping a locked card spends a look, reveals the body, and ticks the local view count", async () => {
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
        return { consumed: false, viewCount: 1, viewLimit: 3, body: "peekaboo" };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    await user.click(screen.getByRole("button", { name: /Tap to view/ }));

    await waitFor(() => expect(screen.getByText("peekaboo")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Tap to view/ })).not.toBeInTheDocument();
    // 3 - 1 = 2 left, reflected in the small badge next to the revealed text.
    expect(screen.getByText(/1\/3 opened/)).toBeInTheDocument();
  });

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

  it("the existing message:deleted broadcast removes a consumed views-mode message from BOTH participants' views", async () => {
    const locked = makeMessage({
      messageId: "msg-consume",
      senderId: ME_ID,
      body: null,
      disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null },
    });
    await renderPage([locked]);
    expect(await screen.findByText("View once")).toBeInTheDocument();

    act(() => {
      fakeSocket.simulateMessageDeleted({ messageId: "msg-consume", conversationId: CONV_ID });
    });

    await waitFor(() => expect(screen.queryByText("View once")).not.toBeInTheDocument());
    expect(await screen.findByText("Message deleted")).toBeInTheDocument();
  });
});

describe("ChatThreadPage — disappearing messages: time mode", () => {
  it("shows the body normally, plus a countdown indicator, and the sweep's message:deleted removes it live", async () => {
    const timed = makeMessage({
      messageId: "msg-timed",
      body: "visible now",
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
    });
    await renderPage([timed]);

    expect(await screen.findByText("visible now", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("5m")).toBeInTheDocument();

    // No manual refresh — the same broadcast every other soft-delete path
    // uses removes it live for whoever's looking, sender or recipient.
    act(() => {
      fakeSocket.simulateMessageDeleted({ messageId: "msg-timed", conversationId: CONV_ID });
    });

    await waitFor(() => expect(screen.queryByText("visible now", { selector: "div" })).not.toBeInTheDocument());
    expect(await screen.findByText("Message deleted")).toBeInTheDocument();
  });
});
