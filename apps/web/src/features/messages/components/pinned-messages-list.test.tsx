import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MAX_PINNED_MESSAGES, type PinnedMessage } from "@relay/contracts";
import { PinnedMessagesList } from "./pinned-messages-list";

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

function makePins(n: number): PinnedMessage[] {
  return Array.from({ length: n }, (_, i) =>
    makePin({
      id: `pin-${i}`,
      messageId: `msg-${i}`,
      message: { senderId: `user-${i}`, senderUsername: `user${i}`, body: `body ${i}`, type: "TEXT", createdAt: new Date().toISOString() },
    }),
  );
}

describe("PinnedMessagesList — cap-reached UI state", () => {
  it(`does NOT show the cap-reached hint below ${MAX_PINNED_MESSAGES} pins`, () => {
    render(<PinnedMessagesList pins={makePins(MAX_PINNED_MESSAGES - 1)} onJump={vi.fn()} onUnpin={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId("pin-cap-reached-hint")).not.toBeInTheDocument();
    expect(screen.getByTestId("pin-count")).toHaveTextContent(`${MAX_PINNED_MESSAGES - 1}/${MAX_PINNED_MESSAGES}`);
  });

  it(`shows the cap-reached hint once at ${MAX_PINNED_MESSAGES} pins`, () => {
    render(<PinnedMessagesList pins={makePins(MAX_PINNED_MESSAGES)} onJump={vi.fn()} onUnpin={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("pin-cap-reached-hint")).toBeInTheDocument();
    expect(screen.getByTestId("pin-count")).toHaveTextContent(`${MAX_PINNED_MESSAGES}/${MAX_PINNED_MESSAGES}`);
  });

  it("shows an empty state when there are no pins", () => {
    render(<PinnedMessagesList pins={[]} onJump={vi.fn()} onUnpin={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("No pinned messages yet.")).toBeInTheDocument();
  });

  it("lists every pinned message with its sender, pinned-by, and an Unpin action", () => {
    const pins = makePins(2);
    render(<PinnedMessagesList pins={pins} onJump={vi.fn()} onUnpin={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("body 0")).toBeInTheDocument();
    expect(screen.getByText("body 1")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Unpin")).toHaveLength(2);
  });

  it("calls onUnpin with the message's id when its Unpin button is clicked", () => {
    const onUnpin = vi.fn();
    const pins = makePins(1);
    render(<PinnedMessagesList pins={pins} onJump={vi.fn()} onUnpin={onUnpin} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Unpin"));
    expect(onUnpin).toHaveBeenCalledWith("msg-0");
  });

  it("calls onJump with the message's id when its preview is clicked", () => {
    const onJump = vi.fn();
    const pins = makePins(1);
    render(<PinnedMessagesList pins={pins} onJump={onJump} onUnpin={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("body 0"));
    expect(onJump).toHaveBeenCalledWith("msg-0");
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<PinnedMessagesList pins={[]} onJump={vi.fn()} onUnpin={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
