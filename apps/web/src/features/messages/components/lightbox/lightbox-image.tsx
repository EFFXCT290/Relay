"use client";

import { useEffect, useState } from "react";
import type { ImageAttachment } from "@relay/contracts";

type Props = { attachment: ImageAttachment };

export function LightboxImage({ attachment }: Props) {
  const { url, thumbUrl, width, height, thumbWidth, thumbHeight } = attachment.media;

  // Thumb shows immediately — same strategy as the bubble but full-viewport.
  const [originalReady, setOriginalReady] = useState(false);

  // Preload original off-screen before committing to render.
  useEffect(() => {
    setOriginalReady(false);
    const img = new window.Image();
    img.onload  = () => setOriginalReady(true);
    img.onerror = () => setOriginalReady(true); // reveal whatever we have on error
    img.src = url;
    return () => { img.onload = null; img.onerror = null; };
  }, [url]);

  // Use original dimensions when available (better aspect for lightbox sizing).
  const aspect = width && height ? width / height : (thumbWidth && thumbHeight ? thumbWidth / thumbHeight : null);

  return (
    <div
      className="relative flex max-h-full max-w-full items-center justify-center"
      style={{
        // Reserve space based on known aspect ratio so the container doesn't
        // collapse while the original is loading.
        ...(aspect ? { aspectRatio: String(aspect) } : {}),
        maxWidth: "min(90vw, 1200px)",
        maxHeight: "min(88dvh, 1200px)",
      }}
      // Prevent backdrop click from closing when the image itself is clicked.
      onClick={(e) => e.stopPropagation()}
    >
      {/* Thumb layer — always underneath, blurred slightly to smooth the transition */}
      {thumbUrl && (
        <img
          src={thumbUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full rounded-xl object-contain"
          style={{ filter: originalReady ? "none" : "blur(6px)", transition: "filter 0.3s" }}
          draggable={false}
        />
      )}

      {/* Original — fades in once preloaded */}
      <img
        src={url}
        alt=""
        className="relative block h-full max-h-[88dvh] w-full max-w-full rounded-xl object-contain transition-opacity duration-300"
        style={{ opacity: originalReady ? 1 : 0 }}
        draggable={false}
      />
    </div>
  );
}
