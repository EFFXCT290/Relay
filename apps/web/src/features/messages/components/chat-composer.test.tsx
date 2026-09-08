import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatComposer } from "./chat-composer";

describe("ChatComposer — disappear choice is a one-shot per-message pick", () => {
  it("sends the armed disappear value with the message, then resets to off for the next send", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatComposer onSend={onSend} />);
    const user = userEvent.setup();

    // Arm "Views: 2" via the picker before the first send.
    await user.click(screen.getByLabelText("Set message to disappear"));
    await user.click(screen.getByText("Views"));
    await user.click(screen.getByText("2"));
    expect(screen.getByLabelText("Disappearing message settings (on)")).toHaveAttribute("aria-pressed", "true");

    await user.type(screen.getByPlaceholderText("Message…"), "first message{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenNthCalledWith(1, "first message", null, { mode: "views", viewLimit: 2 });

    // Reset to "off" — trigger no longer shows the armed label/state.
    await waitFor(() =>
      expect(screen.getByLabelText("Set message to disappear")).toHaveAttribute("aria-pressed", "false"),
    );

    // A second send, with nothing re-armed, must go out as a normal message.
    await user.type(screen.getByPlaceholderText("Message…"), "second message{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenNthCalledWith(2, "second message", null, undefined);
  });

  it("switching modes before sending only sends the final armed choice", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatComposer onSend={onSend} />);
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("Set message to disappear"));
    await user.click(screen.getByText("Views"));
    await user.click(screen.getByText("5"));
    // Changed their mind — switch to a timer instead.
    await user.click(screen.getByText("Timer"));
    await user.click(screen.getByText("1h"));

    await user.type(screen.getByPlaceholderText("Message…"), "timed message{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("timed message", null, { mode: "time", ttlSeconds: 3600 });
  });

  it("the disappear picker is hidden while editing an existing message", () => {
    render(
      <ChatComposer
        onSend={vi.fn()}
        editing={{
          messageId: "m1",
          conversationId: "c1",
          senderId: "u1",
          senderUsername: "me",
          type: "TEXT",
          body: "editing this",
          replyTo: null,
          isEdited: false,
          editedAt: null,
          isDeleted: false,
          reactions: {},
          myReaction: null,
          readBy: [],
          deliveredAt: null,
          createdAt: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.queryByLabelText("Set message to disappear")).not.toBeInTheDocument();
  });
});

describe("ChatComposer — reply preview truncates instead of overflowing the bar", () => {
  const longBody =
    "This is a genuinely long replied-to message body, long enough that if it were allowed to render at its full intrinsic width it would blow out the reply chip and push the message input box below it right out of its normal layout position.";

  it("renders the full text in the DOM (real ellipsis via CSS, not a manual substring cut) with the truncate class applied", async () => {
    render(
      <ChatComposer
        onSend={vi.fn()}
        replyTo={{
          messageId: "m1",
          conversationId: "c1",
          senderId: "u1",
          senderUsername: "alice",
          type: "TEXT",
          body: longBody,
          replyTo: null,
          isEdited: false,
          editedAt: null,
          isDeleted: false,
          reactions: {},
          myReaction: null,
          readBy: [],
          deliveredAt: null,
          createdAt: new Date().toISOString(),
        }}
        onCancelReply={vi.fn()}
      />,
    );

    const preview = await screen.findByText(longBody);
    expect(preview.className).toContain("truncate");

    // The regression itself: without min-w-0 on this flex-1 ancestor, the
    // row never shrinks below the text's intrinsic width, so `truncate`
    // has nothing to actually clip and the bar (and the input below it)
    // gets pushed by a long message — see the fix's comment in
    // chat-composer.tsx's ReplyOrEditChip.
    expect(preview.parentElement?.className).toContain("min-w-0");
    expect(preview.parentElement?.className).toContain("flex-1");
  });
});
