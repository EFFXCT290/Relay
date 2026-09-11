import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// Covers CallsPage's initial loading state — same mocked api() pattern used
// by conversations/page.test.tsx.

let apiImpl: (path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { method?: string; body?: unknown }) => apiImpl(path, opts) };
});

let CallsPage: typeof import("./page").default;

beforeEach(async () => {
  apiImpl = async (path) => {
    throw new Error(`unexpected api() call in this test: ${path}`);
  };
  vi.resetModules();
  CallsPage = (await import("./page")).default;
});

describe("CallsPage — loading state", () => {
  it("shows 4 avatar-circle + 2-line skeleton rows while the call history is in flight", async () => {
    apiImpl = () => new Promise(() => {}); // never resolves — keeps the page in its loading state

    const { container } = render(<CallsPage />);

    const rows = await waitFor(() => {
      const found = container.querySelectorAll("li");
      expect(found.length).toBe(4);
      return found;
    });
    for (const row of rows) {
      expect(row.querySelectorAll(".animate-pulse.rounded-full")).toHaveLength(1); // avatar circle
      expect(row.querySelectorAll(".animate-pulse:not(.rounded-full)")).toHaveLength(2); // 2 text lines
    }
  });
});
