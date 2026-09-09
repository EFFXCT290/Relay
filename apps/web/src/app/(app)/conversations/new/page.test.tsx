import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Regression coverage: GET /api/users/search always returned a real,
// signed avatarUrl, but the result row never wired it into <Avatar> — the
// SearchHit type didn't even declare the field, so the real image was
// silently dropped and every row fell back to the initials gradient. This
// drives the real component through a mocked api() transport (same pattern
// as conversations/[id]/page.test.tsx) rather than re-testing at the prop
// level, so a regression here would actually be visible in what renders.

const routerStub = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
}));

let apiImpl: (path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { method?: string; body?: unknown }) => apiImpl(path, opts) };
});

let NewMessagePage: typeof import("./page").default;

beforeEach(async () => {
  routerStub.replace.mockClear();
  routerStub.push.mockClear();
  apiImpl = async (path) => {
    throw new Error(`unexpected api() call in this test: ${path}`);
  };
  vi.resetModules();
  NewMessagePage = (await import("./page")).default;
});

describe("NewMessagePage — search result avatars", () => {
  it("renders the real avatarUrl as the row's image when the search hit has one", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/api/users/search")) {
        return {
          users: [
            { userId: "user-1", username: "withavatar", avatarUrl: "https://minio.example/avatars/user-1.webp?X-Amz-Expires=3600" },
          ],
        };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    render(<NewMessagePage />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search by username…"), "withavatar");

    const img = await screen.findByRole("img", { name: "@withavatar" });
    expect(img).toHaveAttribute("src", "https://minio.example/avatars/user-1.webp?X-Amz-Expires=3600");
  });

  it("falls back to the initials gradient (no <img>) when the search hit's avatarUrl is null", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/api/users/search")) {
        return { users: [{ userId: "user-2", username: "noavatar", avatarUrl: null }] };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    render(<NewMessagePage />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search by username…"), "noavatar");

    await waitFor(() => expect(screen.getByText("@noavatar")).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: "@noavatar" })).not.toBeInTheDocument();
    // Avatar's initials fallback: first letter of the username, uppercased.
    expect(screen.getByText("N")).toBeInTheDocument();
  });
});
