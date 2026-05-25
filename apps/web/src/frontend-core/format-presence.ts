// Pure presence formatter — no React, no side-effects, safe to call anywhere.
// Centralised here so every surface (list, thread header, profile cards) renders
// identical text. Call site re-renders every 60s so relative text stays current.
//
// Output examples:
//   Active now
//   Last seen just now @ 2:14 PM
//   Last seen 5m ago @ 2:14 PM
//   Last seen 2h ago @ 11:48 AM
//   Last seen yesterday @ 8:32 PM
//   Last seen on Monday @ 4:12 PM
//   Last seen on May 12 @ 9:01 AM
//   Last seen on Dec 8, 2025 @ 6:45 PM  (cross-year only)
//   Offline                             (isOnline false, no lastSeen on record)

export function formatLastSeen(
  lastSeenAt: string | null | undefined,
  isOnline?: boolean,
): string {
  if (isOnline) return "Active now";
  if (!lastSeenAt) return "Offline";

  const date   = new Date(lastSeenAt);
  const now    = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr  = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (diffMin < 1)  return `Last seen just now @ ${time}`;
  if (diffMin < 60) return `Last seen ${diffMin}m ago @ ${time}`;
  if (diffHr  < 24) return `Last seen ${diffHr}h ago @ ${time}`;

  // Calendar-day comparison — "yesterday" means the user's local previous day,
  // not the 24-48h window. diffDay===1 would misfire at e.g. Wed 3 AM for
  // something that happened Mon 4 AM (47h ago, diffDay=1, but not yesterday).
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Last seen yesterday @ ${time}`;

  if (diffDay < 7) {
    const weekday = date.toLocaleDateString([], { weekday: "long" });
    return `Last seen on ${weekday} @ ${time}`;
  }

  const sameYear = now.getFullYear() === date.getFullYear();
  const datePart = date.toLocaleDateString([], {
    month: "short",
    day:   "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `Last seen on ${datePart} @ ${time}`;
}
