import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Covers SpotifyConnectCard's loading state — was a spinner + text, now a
// row-shaped skeleton matching the real settings Row (icon square + 2 lines).

vi.mock("./use-spotify-connection", () => ({
  readSpotifyRedirectResult: () => ({ result: null, reason: null }),
  useSpotifyConnection: () => ({
    status: null,
    loading: true,
    busy: false,
    error: null,
    connectUrl: "https://example.test/connect",
    disconnect: vi.fn(),
    setShowOnProfile: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { SpotifyConnectCard } from "./spotify-connect-card";

function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("SpotifyConnectCard — loading state", () => {
  it("shows an icon-square + 2-line row skeleton while the connection status is loading", () => {
    const { container } = render(<SpotifyConnectCard />);

    const pulses = Array.from(container.querySelectorAll(".animate-pulse"));
    expect(pulses).toHaveLength(3); // 1 icon square + 2 text lines

    const squares = pulses.filter((el) => classes(el).includes("rounded-[10px]"));
    const lines = pulses.filter((el) => !classes(el).includes("rounded-[10px]"));
    expect(squares).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(container.textContent).not.toContain("loading spotify status");
  });
});
