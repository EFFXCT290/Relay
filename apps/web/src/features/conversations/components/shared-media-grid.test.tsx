import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { MediaGalleryItem } from "@relay/contracts";
import { SharedMediaGrid } from "./shared-media-grid";

vi.mock("@/frontend-core/api-client/media", () => ({
  mediaApi: { gallery: vi.fn() },
}));

import { mediaApi } from "@/frontend-core/api-client/media";

let lastObserverCallback: IntersectionObserverCallback | undefined;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  lastObserverCallback = undefined;
  // Same stub shape as use-in-viewport.test.tsx — the grid's own infinite-
  // scroll effect creates a fresh IntersectionObserver per nextCursor value.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        lastObserverCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    },
  );
});

function image(overrides: { id?: string; messageId?: string; thumbUrl?: string | null } = {}): MediaGalleryItem {
  return {
    messageId: overrides.messageId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attachment: {
      id: overrides.id ?? crypto.randomUUID(),
      type: "image",
      media: {
        id: crypto.randomUUID(),
        url: "https://example.test/full.jpg",
        thumbUrl: overrides.thumbUrl ?? "https://example.test/thumb.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
      },
    },
  };
}

function video(overrides: { id?: string; messageId?: string } = {}): MediaGalleryItem {
  return {
    messageId: overrides.messageId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attachment: {
      id: overrides.id ?? crypto.randomUUID(),
      type: "video",
      media: {
        id: crypto.randomUUID(),
        url: "https://example.test/full.mp4",
        thumbUrl: "https://example.test/thumb.jpg",
        durationMs: 5000,
        mimeType: "video/mp4",
        sizeBytes: 4096,
      },
    },
  };
}

describe("SharedMediaGrid — loading and count", () => {
  it("fetches the first page on mount and shows the real item count", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [image(), image()], nextCursor: null, totalCount: 2 });
    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("2 items")).toBeInTheDocument());
    expect(mediaApi.gallery).toHaveBeenCalledWith("conv-1", undefined, 30);
  });

  it("shows an empty state when the conversation has no media", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("No media in this conversation yet.")).toBeInTheDocument());
  });
});

describe("SharedMediaGrid — video overlay", () => {
  it("shows the play-icon overlay on video tiles, not on image tiles", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [image({ id: "img-1" }), video({ id: "vid-1" })], nextCursor: null, totalCount: 2 });
    // Portaled to document.body, not RTL's own `container` wrapper — query
    // document directly, same as `screen` does.
    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("2 items")).toBeInTheDocument());

    const playIcons = document.querySelectorAll("svg.lucide-circle-play");
    expect(playIcons).toHaveLength(1);
  });
});

describe("SharedMediaGrid — opening items", () => {
  it("tapping an image tile opens the image lightbox", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [image({ id: "img-1" })], nextCursor: null, totalCount: 1 });
    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("1 item")).toBeInTheDocument());

    const tile = document.querySelector('img[alt=""]')!.closest("button")!;
    fireEvent.click(tile);
    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeInTheDocument();
  });

  it("tapping a video tile opens its source in a new tab instead of the lightbox (no video viewer exists yet)", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [video({ id: "vid-1" })], nextCursor: null, totalCount: 1 });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("1 item")).toBeInTheDocument());

    const tile = document.querySelector('img[alt=""]')!.closest("button")!;
    fireEvent.click(tile);
    expect(openSpy).toHaveBeenCalledWith("https://example.test/full.mp4", "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("dialog", { name: "Image viewer" })).not.toBeInTheDocument();
  });
});

describe("SharedMediaGrid — pagination", () => {
  it("fetches the next page when the sentinel intersects, appending (not replacing) items", async () => {
    vi.mocked(mediaApi.gallery)
      .mockResolvedValueOnce({ items: [image({ id: "img-1" })], nextCursor: "cursor-1", totalCount: 2 })
      .mockResolvedValueOnce({ items: [image({ id: "img-2" })], nextCursor: null, totalCount: 2 });

    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);
    await waitFor(() => expect(mediaApi.gallery).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastObserverCallback).toBeDefined());

    act(() => {
      lastObserverCallback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    await waitFor(() => expect(mediaApi.gallery).toHaveBeenCalledWith("conv-1", "cursor-1", 30));
    await waitFor(() => expect(mediaApi.gallery).toHaveBeenCalledTimes(2));
  });
});

describe("SharedMediaGrid — responsive shell and close", () => {
  it("is one component switching via lg: classes — no scrim on mobile, fixed-width panel at lg:", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
    render(<SharedMediaGrid conversationId="conv-1" onClose={vi.fn()} />);
    await waitFor(() => screen.getByRole("dialog"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/flex-1/);
    expect(dialog.className).toMatch(/lg:w-\[420px\]/);
    const scrim = dialog.previousElementSibling as HTMLElement;
    expect(scrim.className).toMatch(/hidden/);
    expect(scrim.className).toMatch(/lg:block/);
  });

  it("calls onClose from the header button", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
    const onClose = vi.fn();
    render(<SharedMediaGrid conversationId="conv-1" onClose={onClose} />);
    await waitFor(() => screen.getByLabelText("Close"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
