import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { groupByBucket } from "./group-by-bucket";
import type { Notification } from "@relay/contracts";

const NOW = new Date("2026-06-15T14:30:00");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function notif(id: string, createdAt: string): Notification {
  return { notificationId: id, type: "MESSAGE", isRead: false, payload: {}, createdAt } as unknown as Notification;
}

describe("groupByBucket() — items land in the correct bucket", () => {
  it("buckets today/yesterday/this-week/earlier items correctly, in that order", () => {
    const items = [
      notif("today", "2026-06-15T09:00:00"),
      notif("yesterday", "2026-06-14T09:00:00"),
      notif("this-week", "2026-06-10T09:00:00"),
      notif("earlier", "2026-05-01T09:00:00"),
    ];

    const grouped = groupByBucket(items);

    expect(grouped.map((g) => g.label)).toEqual(["Earlier today", "Yesterday", "This week", "Earlier"]);
    expect(grouped.find((g) => g.label === "Earlier today")!.items.map((n) => n.notificationId)).toEqual(["today"]);
    expect(grouped.find((g) => g.label === "Yesterday")!.items.map((n) => n.notificationId)).toEqual(["yesterday"]);
    expect(grouped.find((g) => g.label === "This week")!.items.map((n) => n.notificationId)).toEqual(["this-week"]);
    expect(grouped.find((g) => g.label === "Earlier")!.items.map((n) => n.notificationId)).toEqual(["earlier"]);
  });
});
