import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ImageAttachment } from "@relay/contracts";
import { ImageBubble } from "./image-bubble";

// ImageBubble uses useInViewport (IntersectionObserver) to lazy-load its real
// <img> — jsdom has no IntersectionObserver, so stub it (same as
// use-in-viewport.test.tsx). Not asserting on lazy-load behavior itself here,
// just preventing the "not defined" crash.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);

// Covers the pre-load placeholder — now the shared Skeleton primitive instead
// of an ad-hoc animate-pulse div, shape unchanged (fills the clamped
// width/height box with var(--color-raised)).

function makeAttachment(overrides: Partial<ImageAttachment["media"]> = {}): ImageAttachment {
  return {
    id: "att-1",
    type: "image",
    media: {
      id: "med-1",
      url: "https://example.test/full.jpg",
      thumbUrl: "https://example.test/thumb.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      ...overrides,
    },
  };
}

describe("ImageBubble — loading placeholder", () => {
  it("shows a pulsing skeleton sized to the clamped image box when there's no blur preview", () => {
    const { container } = render(<ImageBubble attachment={makeAttachment({ blurUrl: null })} isMine={false} />);

    const pulses = container.querySelectorAll(".animate-pulse");
    expect(pulses).toHaveLength(1);
    const el = pulses[0] as HTMLElement;
    expect(el.style.width).toBe("280px"); // default clamp — no width/height metadata given
    expect(el.style.height).toBe("360px");
  });

  it("removes the skeleton once the real image fires onLoad", () => {
    const { container } = render(<ImageBubble attachment={makeAttachment({ blurUrl: null })} isMine={false} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1);

    fireEvent.load(container.querySelector("img")!);

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("uses the blur preview instead of the pulse skeleton when a blurUrl is present", () => {
    const { container } = render(
      <ImageBubble attachment={makeAttachment({ blurUrl: "https://example.test/blur.jpg" })} isMine={false} />,
    );
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(container.querySelector('img[alt=""][aria-hidden]')).toBeTruthy();
  });
});
