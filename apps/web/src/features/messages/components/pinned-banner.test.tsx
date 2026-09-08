import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PinnedMessage } from "@relay/contracts";
import { PinnedBanner } from "./pinned-banner";

function makePin(overrides: Partial<PinnedMessage> = {}): PinnedMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    conversationId: "conv-1",
    messageId: overrides.messageId ?? crypto.randomUUID(),
    pinnedBy: "user-a",
    pinnedByUsername: "alice",
    pinnedAt: new Date().toISOString(),
    message: {
      senderId: "user-a",
      senderUsername: "alice",
      body: "hello",
      type: "TEXT",
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("PinnedBanner", () => {
  it("renders nothing when there are no pins", () => {
    const { container } = render(<PinnedBanner pins={[]} onJump={vi.fn()} onOpenList={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the most recently pinned message (index 0) first, with no cycle indicator for a single pin", () => {
    const pins = [makePin({ message: { senderId: "a", senderUsername: "alice", body: "only pin", type: "TEXT", createdAt: new Date().toISOString() } })];
    render(<PinnedBanner pins={pins} onJump={vi.fn()} onOpenList={vi.fn()} />);
    expect(screen.getByText("only pin")).toBeInTheDocument();
    expect(screen.queryByLabelText("Show next pinned message")).not.toBeInTheDocument();
  });

  it("cycles to the next pin when the '#/#' indicator is tapped, wrapping back to the first", () => {
    const pins = [
      makePin({ message: { senderId: "a", senderUsername: "alice", body: "pin one", type: "TEXT", createdAt: new Date().toISOString() } }),
      makePin({ message: { senderId: "b", senderUsername: "bob", body: "pin two", type: "TEXT", createdAt: new Date().toISOString() } }),
      makePin({ message: { senderId: "c", senderUsername: "carol", body: "pin three", type: "TEXT", createdAt: new Date().toISOString() } }),
    ];
    render(<PinnedBanner pins={pins} onJump={vi.fn()} onOpenList={vi.fn()} />);

    expect(screen.getByText("pin one")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show next pinned message"));
    expect(screen.getByText("pin two")).toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show next pinned message"));
    expect(screen.getByText("pin three")).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();

    // Wraps back to the first pin after the last.
    fireEvent.click(screen.getByLabelText("Show next pinned message"));
    expect(screen.getByText("pin one")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("calls onJump with the currently-displayed pin's messageId when the preview is tapped", () => {
    const onJump = vi.fn();
    const target = makePin({ messageId: "target-message-id" });
    render(<PinnedBanner pins={[target]} onJump={onJump} onOpenList={vi.fn()} />);

    fireEvent.click(screen.getByText("hello"));
    expect(onJump).toHaveBeenCalledWith("target-message-id");
  });

  it("resets to the newest pin (index 0) when a new pin lands while mid-cycle", () => {
    const pinA = makePin({ id: "pin-a", message: { senderId: "a", senderUsername: "alice", body: "pin A", type: "TEXT", createdAt: new Date().toISOString() } });
    const pinB = makePin({ id: "pin-b", message: { senderId: "b", senderUsername: "bob", body: "pin B", type: "TEXT", createdAt: new Date().toISOString() } });

    const { rerender } = render(<PinnedBanner pins={[pinA, pinB]} onJump={vi.fn()} onOpenList={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Show next pinned message"));
    expect(screen.getByText("pin B")).toBeInTheDocument();

    // A fresh pin lands at the front (server orders desc by pinnedAt) —
    // banner should snap back to showing it, not stay on the old index.
    const pinC = makePin({ id: "pin-c", message: { senderId: "c", senderUsername: "carol", body: "pin C", type: "TEXT", createdAt: new Date().toISOString() } });
    rerender(<PinnedBanner pins={[pinC, pinA, pinB]} onJump={vi.fn()} onOpenList={vi.fn()} />);
    expect(screen.getByText("pin C")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("falls back to a type-based label when the pinned message has no body (e.g. media)", () => {
    const pin = makePin({ message: { senderId: "a", senderUsername: "alice", body: null, type: "IMAGE", createdAt: new Date().toISOString() } });
    render(<PinnedBanner pins={[pin]} onJump={vi.fn()} onOpenList={vi.fn()} />);
    expect(screen.getByText("Photo")).toBeInTheDocument();
  });

  it("calls onOpenList when 'View all' is tapped", () => {
    const onOpenList = vi.fn();
    render(<PinnedBanner pins={[makePin()]} onJump={vi.fn()} onOpenList={onOpenList} />);
    fireEvent.click(screen.getByText("View all"));
    expect(onOpenList).toHaveBeenCalledTimes(1);
  });

  it("a genuinely long preview renders with the real ellipsis truncation, not a manual substring cut", () => {
    const longBody =
      "A very long pinned message body — long enough that at full intrinsic width it would blow out the banner's single-row layout if truncation weren't actually engaged.";
    const pin = makePin({ message: { senderId: "a", senderUsername: "alice", body: longBody, type: "TEXT", createdAt: new Date().toISOString() } });
    render(<PinnedBanner pins={[pin]} onJump={vi.fn()} onOpenList={vi.fn()} />);

    // Full text present (real CSS ellipsis, no server/client-side slicing).
    const preview = screen.getByText(longBody);
    expect(preview.className).toContain("truncate");
    // min-w-0 on the flex-1 ancestor is what lets `truncate` actually clip —
    // without it the row never shrinks below the text's intrinsic width.
    expect(preview.closest("button")?.className).toContain("min-w-0");
  });
});
