import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { VideoAttachment } from "@relay/contracts";
import { VideoBubble } from "./video-bubble";

// Covers the no-poster base fallback — now the shared Skeleton primitive
// instead of an ad-hoc animate-pulse div. The "processing" spinner/text
// overlay is untouched by this change and must still render alongside it.

function makeAttachment(overrides: Partial<VideoAttachment["media"]> = {}): VideoAttachment {
  return {
    id: "att-1",
    type: "video",
    media: {
      id: "med-1",
      url: "https://example.test/full.mp4",
      streamUrl: "https://example.test/stream.mp4",
      posterUrl: null,
      thumbUrl: null,
      durationMs: 5000,
      mimeType: "video/mp4",
      sizeBytes: 4096,
      status: "ready",
      ...overrides,
    },
  };
}

describe("VideoBubble — loading placeholder", () => {
  it("shows a pulsing skeleton fallback when there's no poster/thumb", () => {
    const { container } = render(<VideoBubble attachment={makeAttachment()} isMine={false} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1);
  });

  it("shows no pulsing skeleton once a poster image is available", () => {
    const { container } = render(
      <VideoBubble attachment={makeAttachment({ posterUrl: "https://example.test/poster.jpg" })} isMine={false} />,
    );
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("keeps the 'Processing…' spinner overlay working alongside the base pulse fallback", () => {
    const { container, getByText } = render(
      <VideoBubble attachment={makeAttachment({ status: "processing", streamUrl: null })} isMine={false} />,
    );
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1); // base fallback, untouched
    expect(getByText("Processing…")).toBeInTheDocument(); // overlay, untouched
  });
});
