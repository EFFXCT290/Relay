import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

describe("api() — single-flight 401-refresh coalescing", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let refreshCalls: number;
  let callCounts: Map<string, number>;

  beforeEach(() => {
    refreshCalls = 0;
    callCounts = new Map();
    vi.stubGlobal("fetch", vi.fn());
    fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Every non-refresh path 401s exactly once, then succeeds on retry —
  // mirrors a real access token that lapsed mid-session and gets fixed by
  // the single shared refresh.
  function installHappyPathMock() {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        return jsonResponse(200, { ok: true });
      }
      const n = (callCounts.get(url) ?? 0) + 1;
      callCounts.set(url, n);
      if (n === 1) {
        return jsonResponse(401, { type: "", title: "Unauthorized", status: 401, detail: "token expired" });
      }
      return jsonResponse(200, { data: url });
    });
  }

  it("N concurrent requests that all 401 trigger exactly ONE /auth/refresh call, and all N resolve after it", async () => {
    installHappyPathMock();
    const paths = ["/api/a", "/api/b", "/api/c", "/api/d", "/api/e"];

    const results = await Promise.all(paths.map((p) => api<{ data: string }>(p)));

    expect(refreshCalls).toBe(1);
    results.forEach((r, i) => expect(r.data.endsWith(paths[i]!)).toBe(true));

    // Each original path was fetched exactly twice: the initial 401, then the
    // post-refresh retry — not re-fetched an extra time per waiter.
    for (const p of paths) {
      const hits = fetchMock.mock.calls.filter((c: unknown[]) => urlOf(c[0] as RequestInfo | URL).endsWith(p)).length;
      expect(hits).toBe(2);
    }

    const refreshHits = fetchMock.mock.calls.filter((c: unknown[]) => urlOf(c[0] as RequestInfo | URL).endsWith("/api/auth/refresh")).length;
    expect(refreshHits).toBe(1);
  });

  it("a sequential (non-concurrent) 401 also only refreshes once per lapse, not once per request", async () => {
    installHappyPathMock();

    const first = await api<{ data: string }>("/api/solo");
    expect(first.data.endsWith("/api/solo")).toBe(true);
    expect(refreshCalls).toBe(1);

    // A later, brand-new 401 (token lapsed again) must trigger a SECOND,
    // independent refresh — single-flight coalesces concurrent callers, it
    // must not permanently cache "already refreshed once".
    callCounts.set("http://localhost:3001/api/solo", 0);
    const second = await api<{ data: string }>("/api/solo");
    expect(second.data.endsWith("/api/solo")).toBe(true);
    expect(refreshCalls).toBe(2);
  });

  it("if the single shared refresh fails, every coalesced waiter still resolves (with its own original 401), none hang", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        return jsonResponse(401, { type: "", title: "Unauthorized", status: 401, detail: "refresh token invalid" });
      }
      return jsonResponse(401, { type: "", title: "Unauthorized", status: 401, detail: "token expired" });
    });

    const paths = ["/api/a", "/api/b", "/api/c"];
    const outcomes = await Promise.allSettled(paths.map((p) => api(p)));

    expect(refreshCalls).toBe(1); // still coalesced, even though it fails
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
      expect(((outcome as PromiseRejectedResult).reason as ApiError).status).toBe(401);
    }
  });
});
