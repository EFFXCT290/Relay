import type { Notification } from "@/features/notifications/components/notification-card";

export function groupByBucket(items: Notification[]): { label: string; items: Notification[] }[] {
  const buckets = new Map<string, Notification[]>();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 86_400_000);

  for (const n of items) {
    const t = new Date(n.createdAt).getTime();
    let label: string;
    if (t >= startOfToday.getTime()) label = "Earlier today";
    else if (t >= startOfYesterday.getTime()) label = "Yesterday";
    else if (t >= startOfWeek.getTime()) label = "This week";
    else label = "Earlier";

    const list = buckets.get(label) ?? [];
    list.push(n);
    buckets.set(label, list);
  }

  const order = ["Earlier today", "Yesterday", "This week", "Earlier"];
  return order
    .filter((l) => buckets.has(l))
    .map((label) => ({ label, items: buckets.get(label)! }));
}
