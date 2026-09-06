import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatTime } from "./conversation-row";

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
