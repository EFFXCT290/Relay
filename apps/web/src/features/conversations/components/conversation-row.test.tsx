import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConversationRow, formatTime } from "./conversation-row";
import type { ConversationListItem } from "@relay/contracts";

// One test per time bucket — light smoke coverage, not exhaustive locale
// testing. A fixed "now" avoids the test's own pass/fail depending on when
// it happens to run.
const NOW = new Date("2026-06-15T14:30:00");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("formatTime() — time-bucket formatting", () => {
  it("today: renders a clock time (e.g. '9:00 AM'), not a date", () => {
    const result = formatTime("2026-06-15T09:00:00");
    expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  it("this week (< 7 days ago, but not today): renders a short weekday name", () => {
    const result = formatTime("2026-06-12T09:00:00"); // 3 days before NOW
    expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i);
  });

  it("older (7+ days ago): renders a month + day, not a weekday or clock time", () => {
    const result = formatTime("2026-05-01T09:00:00"); // 45 days before NOW
    expect(result).toMatch(/^[A-Z][a-z]{2}\s+\d{1,2}$/);
  });
});

function baseConversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    conversationId: "conv-1",
    participant: { userId: "user-1", username: "alice" },
    lastMessage: null,
    updatedAt: "2026-06-15T14:00:00.000Z",
    ...overrides,
  };
}

describe("ConversationRow — typing indicator must always win over the Spotify line", () => {
  it("shows the Spotify now-playing line when present and NOT typing", () => {
    render(
      <ConversationRow
        conversation={baseConversation({
          spotify: { trackName: "Nightcall", artistName: "Kavinsky", isPlaying: true },
        })}
      />,
    );
    expect(screen.getByText(/Nightcall/)).toBeInTheDocument();
    expect(screen.queryByText(/typing…/i)).not.toBeInTheDocument();
  });

  it("hides the Spotify line entirely while typing is active — never rendered alongside or instead of a truncated typing indicator", () => {
    render(
      <ConversationRow
        conversation={baseConversation({
          isTyping: true,
          spotify: { trackName: "Nightcall", artistName: "Kavinsky", isPlaying: true },
        })}
      />,
    );
    expect(screen.getByText(/typing…/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nightcall/)).not.toBeInTheDocument();
  });

  it("still shows the typing indicator with no Spotify data at all (unaffected by this feature)", () => {
    render(<ConversationRow conversation={baseConversation({ isTyping: true, spotify: null })} />);
    expect(screen.getByText(/typing…/i)).toBeInTheDocument();
  });
});

describe("ConversationRow — private nickname substitution", () => {
  it("no nickname set: shows the real @username, unprefixed nickname text is absent", () => {
    render(<ConversationRow conversation={baseConversation()} />);
    expect(screen.getByText("@alice")).toBeInTheDocument();
  });

  it("nickname set: shows the plain nickname (no @ prefix, since it isn't a handle), not the real username", () => {
    render(
      <ConversationRow
        conversation={baseConversation({ participant: { userId: "user-1", username: "alice", nickname: "Bug" } })}
      />,
    );
    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.queryByText("@alice")).not.toBeInTheDocument();
  });

  it("nickname explicitly null (server always sends the field): falls back to the real @username, same as absent", () => {
    render(
      <ConversationRow
        conversation={baseConversation({ participant: { userId: "user-1", username: "alice", nickname: null } })}
      />,
    );
    expect(screen.getByText("@alice")).toBeInTheDocument();
  });
});
