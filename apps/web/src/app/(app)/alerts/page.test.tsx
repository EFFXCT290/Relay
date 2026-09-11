import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Covers AlertsPage's LoadingState — now consolidated onto the shared
// Skeleton primitive (previously an ad-hoc animate-pulse block).

vi.mock("@/providers/notifications-provider", () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    loaded: false,
    markAllRead: vi.fn(),
  }),
}));

import AlertsPage from "./page";

describe("AlertsPage — loading state", () => {
  it("shows 3 icon-square + 2-line skeleton rows while notifications haven't loaded yet", () => {
    const { container } = render(<AlertsPage />);

    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelectorAll(".animate-pulse.rounded-xl")).toHaveLength(1); // icon square
      expect(row.querySelectorAll(".animate-pulse:not(.rounded-xl)")).toHaveLength(2); // 2 text lines
    }
  });
});
