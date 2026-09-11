import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Regression coverage for /conversations/search actually being a real page:
// previously this route had no page.tsx, so Next's [id] dynamic route caught
// it with id="search" (see ../[id]/page.invalid-id.test.tsx). This drives the
// real component through a mocked api() transport, same pattern as
// conversations/new/page.test.tsx.

let apiImpl: (path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { method?: string; body?: unknown }) => apiImpl(path, opts) };
});

let ConversationSearchPage: typeof import("./page").default;

beforeEach(async () => {
  apiImpl = async (path) => {
    throw new Error(`unexpected api() call in this test: ${path}`);
  };
  vi.resetModules();
  ConversationSearchPage = (await import("./page")).default;
});

describe("ConversationSearchPage", () => {
  it("renders a username match with no snippet line falling back to the handle", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/api/conversations/search")) {
        return {
          results: [
            {
              conversationId: "conv-1",
              participant: { userId: "u1", username: "brightspark", nickname: null, avatarUrl: null },
              matchType: "participant",
              snippet: null,
              messageId: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    render(<ConversationSearchPage />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations…"), "bright");

    // Two occurrences expected — the title line and the subtitle fallback —
    // confirms the snippet subtitle fell back to the handle, not a stray value.
    expect(await screen.findAllByText("@brightspark")).toHaveLength(2);
  });

  it("renders a content match's snippet as the subtitle, using the nickname as the title", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/api/conversations/search")) {
        return {
          results: [
            {
              conversationId: "conv-2",
              participant: { userId: "u2", username: "realname", nickname: "Bestie", avatarUrl: null },
              matchType: "content",
              snippet: "…let's grab coffee tomorrow…",
              messageId: "msg-2",
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      }
      throw new Error(`unexpected call: ${path}`);
    };

    render(<ConversationSearchPage />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations…"), "coffee");

    expect(await screen.findByText("Bestie")).toBeInTheDocument();
    expect(screen.getByText("…let's grab coffee tomorrow…")).toBeInTheDocument();
  });

  it("shows a no-matches state when the search returns nothing", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/api/conversations/search")) return { results: [] };
      throw new Error(`unexpected call: ${path}`);
    };

    render(<ConversationSearchPage />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations…"), "nobody");

    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeInTheDocument());
  });

  it("does not search below the minimum query length", async () => {
    apiImpl = async (path) => {
      throw new Error(`unexpected call for a too-short query: ${path}`);
    };

    render(<ConversationSearchPage />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search conversations…"), "a");

    expect(screen.getByText(/Search by username, nickname, or message content\./)).toBeInTheDocument();
  });

  it("shows 3 avatar-circle + 2-line skeleton rows while a search is in flight", async () => {
    let resolveSearch: ((v: unknown) => void) | undefined;
    apiImpl = (path) => {
      if (path.startsWith("/api/conversations/search")) {
        return new Promise((resolve) => { resolveSearch = resolve; });
      }
      throw new Error(`unexpected call: ${path}`);
    };

    const { container } = render(<ConversationSearchPage />);
    // A single atomic change (not keystroke-by-keystroke typing) — the
    // component's 220ms debounce clears on every `q` change, so simulating
    // real per-character typing here would race multiple independent
    // debounce fires against this test's single `resolveSearch` capture.
    fireEvent.change(screen.getByPlaceholderText("Search conversations…"), { target: { value: "bright" } });

    // The skeleton itself appears the instant `loading` flips true — before
    // the 220ms debounce has even fired the real api() call — so wait for
    // that call (i.e. resolveSearch being captured) before asserting shape,
    // otherwise this races the debounce timer.
    await waitFor(() => expect(resolveSearch).toBeDefined());

    const rows = container.querySelectorAll("li");
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.querySelectorAll(".animate-pulse.rounded-full")).toHaveLength(1); // avatar circle
      expect(row.querySelectorAll(".animate-pulse:not(.rounded-full)")).toHaveLength(2); // 2 text lines
    }

    // Resolve so the pending promise doesn't leak into the next test.
    resolveSearch!({ results: [] });
    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeInTheDocument());
  });
});
