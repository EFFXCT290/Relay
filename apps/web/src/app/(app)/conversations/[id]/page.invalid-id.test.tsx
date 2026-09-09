import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// Regression coverage for the /conversations/search bug: the inbox header's
// not-yet-built "Search" link routes to /conversations/search, which has no
// matching page — Next's [id] route catches it with id="search". Before the
// fix, that fired the detail/messages/pins fetches unguarded, each 422ing
// against the backend's `format: "uuid"` validation. This file confirms a
// malformed id param triggers ZERO network calls and redirects to the inbox
// instead — see page.test.tsx for the full fake-socket/virtualizer
// scaffolding this mirrors (kept separate per that file's own convention of
// one self-contained mock set per concern, since useParams here must return
// a different, invalid id than every other test in this directory expects).

const INVALID_ID = "search";

const routerStub = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: INVALID_ID }),
  useRouter: () => routerStub,
}));

vi.mock("@/providers/me-provider", () => ({
  useMe: () => ({ userId: "22222222-2222-2222-2222-222222222222" }),
}));
vi.mock("@/features/calls/call-provider", () => ({
  useCall: () => ({
    state: { phase: "idle" },
    startCall: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    toggleMute: vi.fn(),
    toggleCamera: vi.fn(),
    switchCamera: vi.fn(),
  }),
}));

class FakeSocket {
  connected = true;
  epoch = 0;
  emit(): void {}
  on(): void {}
  off(): void {}
}
vi.mock("@/frontend-core/socket", () => ({
  getSocket: () => new FakeSocket(),
  getReconnectEpoch: () => 0,
}));

// Tracks every call so the test can assert on count/args, but ALSO fails
// loudly (rather than silently resolving) if the guard is broken and a real
// fetch slips through — a silent success here would hide the exact bug this
// file exists to catch.
const apiSpy = vi.fn(async (path: string, _opts?: unknown) => {
  throw new Error(`api() was called with a malformed id — the guard did not prevent this fetch: ${path}`);
});
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: unknown) => apiSpy(path, opts) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });

let ChatThreadPage: typeof import("./page").default;

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  apiSpy.mockClear();
  routerStub.replace.mockClear();
  vi.resetModules();
  ChatThreadPage = (await import("./page")).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatThreadPage — malformed (non-UUID) id param", () => {
  it("fires zero fetches (detail, messages, pins) and redirects to the inbox instead of 422ing on every one of them", async () => {
    render(<ChatThreadPage />);

    await waitFor(() => expect(routerStub.replace).toHaveBeenCalledWith("/conversations"));

    expect(apiSpy).not.toHaveBeenCalled();
  });
});
