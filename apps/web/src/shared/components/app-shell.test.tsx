import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ChatAwareMain } from "./app-shell";

let pathname = "/conversations";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

// Table-driven across representative paths — confirms the tab-bar-clearing
// bottom padding is dropped (pb-0) on chat-thread routes and kept
// (pb-[92px]) everywhere else.
describe("ChatAwareMain — chat-thread path regex", () => {
  const cases: Array<{ path: string; isChatThread: boolean }> = [
    { path: "/conversations/abc123", isChatThread: true },
    { path: "/conversations/abc123/settings", isChatThread: true },
    { path: "/conversations/new", isChatThread: false }, // explicit exclusion
    { path: "/conversations", isChatThread: false }, // list page, no id
    { path: "/alerts", isChatThread: false },
    { path: "/calls", isChatThread: false },
  ];

  for (const c of cases) {
    it(`${c.path} → isChatThread=${c.isChatThread}`, () => {
      pathname = c.path;
      const { container } = render(<ChatAwareMain>content</ChatAwareMain>);
      const main = container.querySelector("main")!;
      // Exact class-token match — "lg:pb-0" (always present, desktop-only) is
      // a substring of "pb-0" and must not be confused with the mobile-only
      // conditional class this test is actually about.
      const classes = main.className.split(/\s+/);
      expect(classes.includes("pb-0")).toBe(c.isChatThread);
      expect(classes.includes("pb-[92px]")).toBe(!c.isChatThread);
    });
  }
});
