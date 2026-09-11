import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ImageAttachment } from "@relay/contracts";
import { ImageGrid } from "./image-grid";

// GridTile uses useInViewport (IntersectionObserver) to lazy-load its real
// <img> — jsdom has no IntersectionObserver, so stub it (same as
// use-in-viewport.test.tsx). Not asserting on lazy-load behavior itself here,
// just preventing the "not defined" crash.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);

// Covers GridTile's pre-load placeholder — now the shared Skeleton primitive
// instead of an ad-hoc animate-pulse div, shape unchanged (fills the tile).

function makeAttachment(id: string, overrides: Partial<ImageAttachment["media"]> = {}): ImageAttachment {
  return {
    id,
    type: "image",
    media: {
      id: `med-${id}`,
      url: `https://example.test/${id}-full.jpg`,
      thumbUrl: `https://example.test/${id}-thumb.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      ...overrides,
    },
  };
}

describe("ImageGrid — GridTile loading placeholder", () => {
  it("shows one pulsing skeleton per tile when none has a blur preview", () => {
    const attachments = [makeAttachment("a", { blurUrl: null }), makeAttachment("b", { blurUrl: null })];
    const { container } = render(<ImageGrid attachments={attachments} isMine={false} />);

    // 2-image layout: each GridTile is its own <button>.
    const tiles = container.querySelectorAll("button");
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(tile.querySelectorAll(".animate-pulse")).toHaveLength(1);
    }
  });

  it("clears only the loaded tile's skeleton, leaving the other tile's pulse untouched", () => {
    const attachments = [makeAttachment("a", { blurUrl: null }), makeAttachment("b", { blurUrl: null })];
    const { container } = render(<ImageGrid attachments={attachments} isMine={false} />);

    const tiles = container.querySelectorAll("button");
    const firstTileImg = tiles[0]!.querySelector("img")!;
    fireEvent.load(firstTileImg);

    expect(tiles[0]!.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(tiles[1]!.querySelectorAll(".animate-pulse")).toHaveLength(1);
  });
});
