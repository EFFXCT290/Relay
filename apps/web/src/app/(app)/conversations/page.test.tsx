import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// Covers ConversationsPage's LoadingState — same mocked api()/socket pattern
// used by conversations/[id]/page.test.tsx and conversations/new/page.test.tsx.

const routerStub = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
}));

type Listener = (...args: unknown[]) => void;
class FakeSocket {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(): void {}
}
let fakeSocket: FakeSocket;
vi.mock("@/frontend-core/socket", () => ({
  getSocket: () => fakeSocket,
}));

let apiImpl: (path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { method?: string; body?: unknown }) => apiImpl(path, opts) };
});

let ConversationsPage: typeof import("./page").default;

beforeEach(async () => {
  fakeSocket = new FakeSocket();
  routerStub.replace.mockClear();
  routerStub.push.mockClear();
  apiImpl = async (path) => {
    throw new Error(`unexpected api() call in this test: ${path}`);
  };
  vi.resetModules();
  ConversationsPage = (await import("./page")).default;
});

describe("ConversationsPage — loading state", () => {
  it("shows 4 avatar-circle + 2-line skeleton rows while the initial load is in flight", async () => {
    apiImpl = () => new Promise(() => {}); // never resolves — keeps the page in its loading state

    const { container } = render(<ConversationsPage />);

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
