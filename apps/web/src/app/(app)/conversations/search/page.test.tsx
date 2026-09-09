import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
