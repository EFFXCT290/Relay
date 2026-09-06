import type { CallHistoryItem } from "@relay/contracts";

export const GREEN = "#22C55E";
export const RED = "#EF4444";
export const AMBER = "#F59E0B";

// Outcome = the human-readable result of the call, derived from status +
// direction. `missed` (an incoming call you never answered) is the only case
// that gets the row-level red highlight — matching the familiar phone-app
// "missed call" convention. Everything else is just colored text.
export type CallOutcome = { label: string; color: string; missed: boolean };

export function callOutcome(c: CallHistoryItem): CallOutcome {
  // durationSec > 0 is the only proof media actually flowed: the server writes
  // ENDED for both a hung-up live call AND a call cancelled mid-ring, and only
  // the former has a duration. So an ENDED call with no duration never connected.
  const connected = c.durationSec > 0;
  switch (c.status) {
    case "ANSWERED": // transient/crash artifact — treat as a connected call
    case "ENDED":
      if (connected) return { label: "Answered", color: GREEN, missed: false };
      // Ended before connecting: caller cancelled during the ring.
      return c.direction === "incoming"
        ? { label: "Missed", color: RED, missed: true } // caller gave up before you answered
        : { label: "Cancelled", color: AMBER, missed: false };
    case "MISSED":
      // Incoming + unanswered = a missed call; outgoing = the other side never picked up.
      return c.direction === "incoming"
        ? { label: "Missed", color: RED, missed: true }
        : { label: "No answer", color: AMBER, missed: false };
    case "REJECTED":
      // "Declined" reads correctly both ways: you declined an incoming call, or
      // the other side declined your outgoing one.
      return { label: "Declined", color: AMBER, missed: false };
    case "FAILED":
      return { label: "Failed", color: RED, missed: false };
    case "RINGING":
      return { label: "Ringing", color: "var(--color-text-muted)", missed: false };
    default:
      return { label: "", color: "var(--color-text-muted)", missed: false };
  }
}
