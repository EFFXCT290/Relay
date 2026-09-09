import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Message } from "@relay/contracts";
import { MessageBubble } from "./message-bubble";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: "msg-1",
    conversationId: "conv-1",
    senderId: "user-a",
    senderUsername: "alice",
    type: "TEXT",
    body: "the quick brown fox",
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

describe("MessageBubble — search highlight", () => {
  it("wraps a case-insensitive substring match in <mark>, preserving the original casing", () => {
    render(<MessageBubble message={makeMessage()} isMine={false} highlightQuery="BROWN" />);
    const mark = screen.getByText("brown");
    expect(mark.tagName).toBe("MARK");
  });

  it("renders plain text with no <mark> when highlightQuery is absent", () => {
    render(<MessageBubble message={makeMessage()} isMine={false} />);
    expect(screen.getByText("the quick brown fox")).toBeInTheDocument();
    expect(document.querySelector("mark")).not.toBeInTheDocument();
  });

  it("renders plain text with no <mark> when the query doesn't match the body", () => {
    render(<MessageBubble message={makeMessage()} isMine={false} highlightQuery="giraffe" />);
    expect(screen.getByText("the quick brown fox")).toBeInTheDocument();
    expect(document.querySelector("mark")).not.toBeInTheDocument();
  });

  it("never crashes or highlights a disappearing message's body, which never renders as plain text", () => {
    const msg = makeMessage({
      body: "secret payload",
      disappear: { mode: "views", viewLimit: 2, viewCount: 0, expiresAt: null },
    });
    render(<MessageBubble message={msg} isMine={false} highlightQuery="secret" />);
    expect(screen.queryByText(/secret/i)).not.toBeInTheDocument();
  });
});
