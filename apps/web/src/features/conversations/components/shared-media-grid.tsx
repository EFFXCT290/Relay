"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, CirclePlay, X } from "lucide-react";
import { mediaApi } from "@/frontend-core/api-client/media";
import { Skeleton } from "@/shared/ui/skeleton";
import { ImageLightbox, type LightboxState } from "@/features/messages/components/lightbox/image-lightbox";
import type { MediaGalleryItem, ImageAttachment } from "@relay/contracts";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

// Contact info → "Media, links and docs" row. Desktop has no dedicated
// Pencil frame (only a mobile mock exists in relay.pen) — the shell here
// mirrors ContactInfoModal's desktop-modal treatment for visual family
// consistency, at the same 420px width, since no source value exists for it.
export function SharedMediaGrid({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [items, setItems] = useState<MediaGalleryItem[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async (cursor?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await mediaApi.gallery(conversationId, cursor, 30);
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
      setTotalCount(res.totalCount);
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setInitialLoaded(true);
    }
  }, [conversationId]);

  useEffect(() => {
    void loadMore();
  }, [loadMore]);

  // Infinite scroll: fetch the next page once the sentinel at the bottom of
  // the grid enters view. No Pencil frame shows scrolling behavior (a static
  // mock can't) — this is a judgment call, matching the cursor-pagination
  // convention the rest of the app already uses.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore(nextCursor);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !lightbox) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lightbox]);

  function openItem(index: number) {
    const item = items[index];
    if (!item) return;
    // No video lightbox exists in this codebase yet — video cells open their
    // source in a new tab rather than growing a second viewer component here.
    if (item.attachment.type === "video") {
      if (item.attachment.media.url) window.open(item.attachment.media.url, "_blank", "noopener,noreferrer");
      return;
    }
    const images = items
      .map((i) => (i.attachment.type === "image" ? i.attachment : null))
      .filter((a): a is ImageAttachment => a !== null);
    const imageIndex = images.findIndex((a) => a.id === item.attachment.id);
    if (imageIndex === -1) return;
    setLightbox({ images, index: imageIndex });
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[150] flex flex-col">
        <div className="absolute inset-0 hidden lg:block" style={{ background: "#000000B8" }} onClick={onClose} />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Media, links and docs"
          className="relative z-10 flex w-full flex-1 flex-col overflow-hidden lg:mx-auto lg:mt-16 lg:mb-auto lg:h-auto lg:max-h-[85vh] lg:w-[420px] lg:flex-none lg:rounded-[20px] lg:border lg:shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
          style={{ background: "var(--color-bg)", borderColor: "var(--color-hairline-strong)" }}
        >
          <header
            className="flex shrink-0 items-center gap-2 pt-[calc(env(safe-area-inset-top)+10px)] pr-3 pb-[14px] pl-1 lg:gap-0 lg:pt-[18px] lg:pr-4 lg:pb-[10px] lg:pl-5"
          >
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="order-first flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full hover:bg-white/5 lg:order-last lg:h-[30px] lg:w-[30px] lg:bg-[var(--color-panel)]"
            >
              <ArrowLeft className="h-[22px] w-[22px] text-[var(--color-text)] lg:hidden" />
              <X className="hidden h-4 w-4 text-[var(--color-text)] lg:block" />
            </button>
            <span
              className="flex-1 text-center text-[15px] font-bold text-[var(--color-text)] lg:text-left"
              style={{ fontFamily: display }}
            >
              Media, links and docs
            </span>
            <div className="h-[38px] w-[38px] shrink-0 lg:hidden" />
          </header>

          <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-1 pb-[calc(env(safe-area-inset-bottom)+24px)]">
            <span className="text-[12px] text-[var(--color-text-secondary)]" style={{ fontFamily: mono }}>
              {totalCount === null ? " " : `${totalCount} item${totalCount === 1 ? "" : "s"}`}
            </span>

            {!initialLoaded ? (
              <div className="grid grid-cols-3 gap-1">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <Skeleton key={i} className="h-[118px] w-full rounded-[6px]" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <p className="px-2 py-8 text-center text-[13px] text-[var(--color-text-secondary)]">
                No media in this conversation yet.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {items.map((item, i) => (
                  <button
                    key={item.attachment.id}
                    type="button"
                    onClick={() => openItem(i)}
                    className="relative h-[118px] w-full overflow-hidden rounded-[6px]"
                    style={{ background: "var(--color-raised)" }}
                  >
                    <img
                      src={
                        item.attachment.type === "image"
                          ? (item.attachment.media.thumbUrl ?? item.attachment.media.url ?? "")
                          : (item.attachment.media.thumbUrl ?? item.attachment.media.posterUrl ?? "")
                      }
                      alt=""
                      draggable={false}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    {item.attachment.type === "video" && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/10">
                        <CirclePlay className="h-[22px] w-[22px] text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.6)]" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div ref={sentinelRef} className="h-1 w-full" />
            {initialLoaded && loading && (
              <div className="grid grid-cols-3 gap-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-[118px] w-full rounded-[6px]" />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {lightbox && <ImageLightbox state={lightbox} onClose={() => setLightbox(null)} />}
    </>,
    document.body,
  );
}
