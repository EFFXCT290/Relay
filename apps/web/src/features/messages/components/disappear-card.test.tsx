import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Message } from "@relay/contracts";
import { DisappearCard } from "./disappear-card";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: "msg-1",
    conversationId: "conv-1",
    senderId: "user-a",
    senderUsername: "alice",
    type: "TEXT",
    body: null,
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

describe("DisappearCard — views mode", () => {
  it("renders nothing when the message has no disappear metadata", () => {
    const { container } = render(<DisappearCard message={makeMessage()} isMine={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("recipient: shows a locked 'tap to view' card, regardless of whether body happens to be populated", () => {
    // body is deliberately irrelevant to this card now — content only ever
    // shows in the explicit-open modal, never inline (see disappear-card.tsx's
    // header comment on why the card must not key off message.body).
    const msg = makeMessage({
      body: "leaked text would be a bug",
      disappear: { mode: "views", viewLimit: 3, viewCount: 0, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={false} />);
    expect(screen.getByText(/Tap to view/)).toBeInTheDocument();
    expect(screen.getByText(/3 left/)).toBeInTheDocument();
    expect(screen.queryByText("leaked text would be a bug")).not.toBeInTheDocument();
  });

  it("tapping the locked card calls onOpen with the messageId", () => {
    const onOpen = vi.fn();
    const msg = makeMessage({ disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null } });
    render(<DisappearCard message={msg} isMine={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Tap to view/ }));
    expect(onOpen).toHaveBeenCalledWith("msg-1");
  });

  it("sender: non-interactive status line, never a tappable card", () => {
    const onOpen = vi.fn();
    const msg = makeMessage({ disappear: { mode: "views", viewLimit: 2, viewCount: 1, expiresAt: null } });
    render(<DisappearCard message={msg} isMine={true} onOpen={onOpen} />);
    expect(screen.getByText(/2 views/)).toBeInTheDocument();
    expect(screen.getByText(/Opened 1\/2/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("single view-once (viewLimit 1) labels itself 'View once', not '1 view'", () => {
    const msg = makeMessage({ disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null } });
    render(<DisappearCard message={msg} isMine={true} />);
    expect(screen.getByText("View once")).toBeInTheDocument();
  });
});

describe("DisappearCard — time mode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recipient, before the clock has started (expiresAt null): 'Tap to open', no countdown", () => {
    const msg = makeMessage({ disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: null } });
    render(<DisappearCard message={msg} isMine={false} />);
    expect(screen.getByText("Tap to open")).toBeInTheDocument();
  });

  it("sender, before the clock has started: 'Waiting to be opened', non-interactive", () => {
    const onOpen = vi.fn();
    const msg = makeMessage({ disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: null } });
    render(<DisappearCard message={msg} isMine={true} onOpen={onOpen} />);
    expect(screen.getByText("Waiting to be opened")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("recipient, clock running: card shows a ticking 'Tap to view · Xleft' with the remaining time, still tappable (reopening is free)", () => {
    const onOpen = vi.fn();
    const msg = makeMessage({
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
    });
    render(<DisappearCard message={msg} isMine={false} onOpen={onOpen} />);
    expect(screen.getByText(/Tap to view · 5m left/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith("msg-1");
  });

  it("sender, clock running: non-interactive status line shows 'Disappearing in Xh'", () => {
    const onOpen = vi.fn();
    const msg = makeMessage({
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 90 * 60_000).toISOString() },
    });
    render(<DisappearCard message={msg} isMine={true} onOpen={onOpen} />);
    expect(screen.getByText("Disappearing in 2h")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("the card's countdown ticks down on its own coarse interval", () => {
    vi.useFakeTimers();
    const msg = makeMessage({
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 45_000).toISOString() },
    });
    render(<DisappearCard message={msg} isMine={false} />);
    expect(screen.getByText(/45s left/)).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText(/15s left/)).toBeInTheDocument();
  });

  it("body content is never rendered by the card in either not-mine state, even if populated", () => {
    const msg = makeMessage({
      body: "would leak if the card read it",
      disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    render(<DisappearCard message={msg} isMine={false} />);
    expect(screen.queryByText("would leak if the card read it")).not.toBeInTheDocument();
  });
});
