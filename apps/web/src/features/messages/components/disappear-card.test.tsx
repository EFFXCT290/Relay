import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Message } from "@relay/contracts";
import { DisappearCard, DisappearTimer } from "./disappear-card";

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

  it("renders nothing for time-mode messages (handled by the normal bubble instead)", () => {
    const msg = makeMessage({ disappear: { mode: "time", viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const { container } = render(<DisappearCard message={msg} isMine={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("recipient, not yet revealed: shows a locked 'tap to view' card, never the real text", () => {
    const msg = makeMessage({
      body: null,
      disappear: { mode: "views", viewLimit: 3, viewCount: 0, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={false} />);
    expect(screen.getByText(/Tap to view/)).toBeInTheDocument();
    expect(screen.getByText(/3 left/)).toBeInTheDocument();
    expect(screen.queryByText("secret text")).not.toBeInTheDocument();
  });

  it("tapping the locked card calls onView with the messageId", () => {
    const onView = vi.fn();
    const msg = makeMessage({
      body: null,
      disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={false} onView={onView} />);
    fireEvent.click(screen.getByRole("button", { name: /Tap to view/ }));
    expect(onView).toHaveBeenCalledWith("msg-1");
  });

  it("recipient, revealed (body present): shows the real text, not the locked card", () => {
    const msg = makeMessage({
      body: "secret text",
      disappear: { mode: "views", viewLimit: 3, viewCount: 1, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={false} />);
    expect(screen.getByText("secret text")).toBeInTheDocument();
    expect(screen.queryByText(/Tap to view/)).not.toBeInTheDocument();
  });

  it("sender, not revealed: shows a non-interactive status line, never a tappable card", () => {
    const onView = vi.fn();
    const msg = makeMessage({
      body: null,
      disappear: { mode: "views", viewLimit: 2, viewCount: 1, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={true} onView={onView} />);
    expect(screen.getByText(/2 views/)).toBeInTheDocument();
    expect(screen.getByText(/Opened 1\/2/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onView).not.toHaveBeenCalled();
  });

  it("sender, revealed (optimistic send): shows the real text they just typed", () => {
    const msg = makeMessage({
      senderId: "me",
      body: "just sent this",
      disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={true} />);
    expect(screen.getByText("just sent this")).toBeInTheDocument();
  });

  it("single view-once (viewLimit 1) labels itself as 'View once', not '1 view'", () => {
    const msg = makeMessage({
      body: null,
      disappear: { mode: "views", viewLimit: 1, viewCount: 0, expiresAt: null },
    });
    render(<DisappearCard message={msg} isMine={true} />);
    expect(screen.getByText("View once")).toBeInTheDocument();
  });
});

describe("DisappearTimer — time mode countdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a coarse remaining-time label for an expiry a few minutes out", () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    render(<DisappearTimer expiresAt={expiresAt} />);
    expect(screen.getByText("5m")).toBeInTheDocument();
  });

  it("renders hours for an expiry beyond 60 minutes", () => {
    const expiresAt = new Date(Date.now() + 90 * 60_000).toISOString();
    render(<DisappearTimer expiresAt={expiresAt} />);
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("renders nothing once expiresAt is in the past (avoids flashing 0s/negative)", () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    const { container } = render(<DisappearTimer expiresAt={expiresAt} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("updates on its own coarse interval without a re-render from the parent", () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 45_000).toISOString(); // 45s out
    render(<DisappearTimer expiresAt={expiresAt} />);
    expect(screen.getByText("45s")).toBeInTheDocument();

    // Advance past the 30s tick — remaining drops to ~15s.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText("15s")).toBeInTheDocument();
  });
});
