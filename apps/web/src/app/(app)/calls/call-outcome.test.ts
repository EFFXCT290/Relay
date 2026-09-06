import { describe, it, expect } from "vitest";
import { callOutcome } from "./call-outcome";
import type { CallHistoryItem, CallStatus, CallDirection } from "@relay/contracts";

const GREEN = "#22C55E";
const RED = "#EF4444";
const AMBER = "#F59E0B";

function call(status: CallStatus, direction: CallDirection, durationSec: number): CallHistoryItem {
  return {
    id: "c1",
    direction,
    otherUser: { id: "u1", username: "bob" },
    status,
    type: "AUDIO",
    durationSec,
    createdAt: new Date().toISOString(),
  } as unknown as CallHistoryItem;
}

// Denser than the rest of this tier per the plan's own note — a real
// direction × status table, not just one representative case each.
describe("callOutcome() — direction × status table", () => {
  const cases: Array<{ label: string; status: CallStatus; direction: CallDirection; durationSec: number; expected: { label: string; color: string; missed: boolean } }> = [
    { label: "ENDED, incoming, connected", status: "ENDED", direction: "incoming", durationSec: 42, expected: { label: "Answered", color: GREEN, missed: false } },
    { label: "ENDED, outgoing, connected", status: "ENDED", direction: "outgoing", durationSec: 42, expected: { label: "Answered", color: GREEN, missed: false } },
    { label: "ENDED, incoming, never connected (caller gave up)", status: "ENDED", direction: "incoming", durationSec: 0, expected: { label: "Missed", color: RED, missed: true } },
    { label: "ENDED, outgoing, never connected (cancelled during ring)", status: "ENDED", direction: "outgoing", durationSec: 0, expected: { label: "Cancelled", color: AMBER, missed: false } },
    { label: "ANSWERED (crash artifact), incoming, connected — treated like ENDED", status: "ANSWERED", direction: "incoming", durationSec: 10, expected: { label: "Answered", color: GREEN, missed: false } },
    { label: "ANSWERED (crash artifact), outgoing, never connected — treated like ENDED", status: "ANSWERED", direction: "outgoing", durationSec: 0, expected: { label: "Cancelled", color: AMBER, missed: false } },
    { label: "MISSED, incoming", status: "MISSED", direction: "incoming", durationSec: 0, expected: { label: "Missed", color: RED, missed: true } },
    { label: "MISSED, outgoing", status: "MISSED", direction: "outgoing", durationSec: 0, expected: { label: "No answer", color: AMBER, missed: false } },
    { label: "REJECTED, incoming", status: "REJECTED", direction: "incoming", durationSec: 0, expected: { label: "Declined", color: AMBER, missed: false } },
    { label: "REJECTED, outgoing", status: "REJECTED", direction: "outgoing", durationSec: 0, expected: { label: "Declined", color: AMBER, missed: false } },
    { label: "FAILED, incoming", status: "FAILED", direction: "incoming", durationSec: 0, expected: { label: "Failed", color: RED, missed: false } },
    { label: "FAILED, outgoing", status: "FAILED", direction: "outgoing", durationSec: 0, expected: { label: "Failed", color: RED, missed: false } },
    { label: "RINGING, outgoing", status: "RINGING", direction: "outgoing", durationSec: 0, expected: { label: "Ringing", color: "var(--color-text-muted)", missed: false } },
  ];

  for (const c of cases) {
    it(c.label, () => {
      expect(callOutcome(call(c.status, c.direction, c.durationSec))).toEqual(c.expected);
    });
  }

  it("an unrecognized status falls back to an empty label rather than throwing", () => {
    const weird = call("SOMETHING_NEW" as CallStatus, "incoming", 0);
    expect(callOutcome(weird)).toEqual({ label: "", color: "var(--color-text-muted)", missed: false });
  });
});
