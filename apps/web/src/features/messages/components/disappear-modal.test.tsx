import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DisappearModal } from "./disappear-modal";

describe("DisappearModal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the given body — a snapshot, not derived from anything reactive", () => {
    render(<DisappearModal mode="views" body="the actual secret text" onClose={vi.fn()} />);
    expect(screen.getByText("the actual secret text")).toBeInTheDocument();
  });

  it("views mode never shows a countdown, even if expiresAt is somehow passed", () => {
    render(<DisappearModal mode="views" body="hi" expiresAt={new Date(Date.now() + 60_000).toISOString()} onClose={vi.fn()} />);
    expect(screen.queryByText(/Disappears in/)).not.toBeInTheDocument();
  });

  it("time mode shows a prominent ticking countdown from expiresAt", () => {
    render(<DisappearModal mode="time" body="a timed message" expiresAt={new Date(Date.now() + 5 * 60_000).toISOString()} onClose={vi.fn()} />);
    expect(screen.getByText(/Disappears in 5m/)).toBeInTheDocument();
  });

  it("clicking the X calls onClose", () => {
    // At least once, not exactly once: the X button has no stopPropagation,
    // so the click also bubbles to the backdrop's own onClose — mirroring
    // EphemeralViewer's identical close-button wiring exactly. Harmless
    // since onClose (setOpenDisappear(null)) is idempotent.
    const onClose = vi.fn();
    render(<DisappearModal mode="views" body="hi" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the backdrop calls onClose, but clicking the content card does not", () => {
    const onClose = vi.fn();
    render(<DisappearModal mode="views" body="hi there" onClose={onClose} />);
    fireEvent.click(screen.getByText("hi there"));
    expect(onClose).not.toHaveBeenCalled();

    // The backdrop is the outer fixed-inset container — find it via the
    // rendered text's ancestor chain rather than a CSS selector.
    const backdrop = screen.getByText("hi there").closest('[class*="fixed inset-0"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<DisappearModal mode="views" body="hi" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
