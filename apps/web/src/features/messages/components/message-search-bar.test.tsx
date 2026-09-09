import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let apiImpl: (path: string, opts?: { signal?: AbortSignal }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { signal?: AbortSignal }) => apiImpl(path, opts) };
});

let MessageSearchBar: typeof import("./message-search-bar").MessageSearchBar;

beforeEach(async () => {
  apiImpl = async (path) => {
    throw new Error(`unexpected api() call in this test: ${path}`);
  };
  vi.resetModules();
  ({ MessageSearchBar } = await import("./message-search-bar"));
});

const HIT = (messageId: string, snippet: string) => ({
  messageId,
  type: "TEXT",
  senderId: "user-1",
  createdAt: new Date().toISOString(),
  snippet,
  matchedIn: "body" as const,
});

describe("MessageSearchBar", () => {
  it("jumps to the most recent match (hits[0]) as soon as results arrive", async () => {
    apiImpl = async (path) => {
      if (path.includes("/messages/search")) {
        return { hits: [HIT("msg-newest", "newest"), HIT("msg-older", "older")] };
      }
      throw new Error(`unexpected call: ${path}`);
    };
    const onJump = vi.fn();

    render(
      <MessageSearchBar conversationId="conv-1" onClose={vi.fn()} onJumpToMessage={onJump} onQueryChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search in conversation"), "hello");

    await waitFor(() => expect(onJump).toHaveBeenCalledWith("msg-newest"));
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });

  it("steps to the next/previous match and wraps at either end", async () => {
    apiImpl = async (path) => {
      if (path.includes("/messages/search")) {
        return { hits: [HIT("msg-a", "a"), HIT("msg-b", "b"), HIT("msg-c", "c")] };
      }
      throw new Error(`unexpected call: ${path}`);
    };
    const onJump = vi.fn();

    render(
      <MessageSearchBar conversationId="conv-1" onClose={vi.fn()} onJumpToMessage={onJump} onQueryChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search in conversation"), "x");
    await waitFor(() => expect(onJump).toHaveBeenCalledWith("msg-a"));

    await user.click(screen.getByLabelText("Next match"));
    expect(onJump).toHaveBeenLastCalledWith("msg-b");
    expect(await screen.findByText("2 of 3")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Previous match"));
    expect(onJump).toHaveBeenLastCalledWith("msg-a");

    // Wraps backward from the first match to the last.
    await user.click(screen.getByLabelText("Previous match"));
    expect(onJump).toHaveBeenLastCalledWith("msg-c");
    expect(await screen.findByText("3 of 3")).toBeInTheDocument();
  });

  it("shows 0 of 0 and disables the arrows when there are no matches", async () => {
    apiImpl = async (path) => {
      if (path.includes("/messages/search")) return { hits: [] };
      throw new Error(`unexpected call: ${path}`);
    };

    render(
      <MessageSearchBar conversationId="conv-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} onQueryChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search in conversation"), "nomatch");

    expect(await screen.findByText("0 of 0")).toBeInTheDocument();
    expect(screen.getByLabelText("Next match")).toBeDisabled();
    expect(screen.getByLabelText("Previous match")).toBeDisabled();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <MessageSearchBar conversationId="conv-1" onClose={onClose} onJumpToMessage={vi.fn()} onQueryChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Close search"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call the search API for a blank query", async () => {
    apiImpl = async (path) => {
      throw new Error(`unexpected call for an empty query: ${path}`);
    };
    render(
      <MessageSearchBar conversationId="conv-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} onQueryChange={vi.fn()} />,
    );
    // Nothing typed — component just mounted with an empty query.
    await new Promise((r) => setTimeout(r, 350));
  });
});
