// Internal shared primitives — not exported from the package index.
// Each provider component imports CardShell, ImageBanner, and AccentStrip
// and plugs in its own header as children.

import type { ReactNode } from "react";
import type { MessageEmbed } from "@relay/contracts";

type ShellProps = {
  embed: MessageEmbed;
  isMine: boolean;
  children: ReactNode;
  descriptionLines?: 2 | 3;
};

export function CardShell({ embed, isMine, children, descriptionLines = 2 }: ShellProps) {
  const site = embed.siteName || hostname(embed.url);
  return (
    <a
      href={embed.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 block w-full max-w-[280px] overflow-hidden rounded-[14px] no-underline lg:max-w-[360px]"
      style={{
        background: isMine ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {children}
      <div className="flex flex-col gap-0.5 px-3 py-2.5">
        {embed.title && (
          <span
            className="line-clamp-2 text-[13px] font-semibold leading-snug"
            style={{ color: isMine ? "rgba(255,255,255,0.95)" : "var(--color-text)" }}
          >
            {embed.title}
          </span>
        )}
        {embed.description && (
          <span
            className={descriptionLines === 3 ? "line-clamp-3 text-[11px] leading-snug" : "line-clamp-2 text-[11px] leading-snug"}
            style={{ color: isMine ? "rgba(255,255,255,0.6)" : "var(--color-text-secondary)" }}
          >
            {embed.description}
          </span>
        )}
        <span
          className="mt-0.5 truncate text-[10px] uppercase tracking-[0.05em]"
          style={{ color: isMine ? "rgba(255,255,255,0.45)" : "var(--color-text-muted)" }}
        >
          {site}
        </span>
      </div>
    </a>
  );
}

export function ImageBanner({
  src,
  alt,
  overlay,
}: {
  src: string;
  alt: string;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative w-full overflow-hidden" style={{ maxHeight: 180 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="w-full object-cover"
        style={{ maxHeight: 180, display: "block" }}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      {overlay}
    </div>
  );
}

export function AccentStrip({
  color,
  children,
}: {
  color: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex h-14 w-full items-center justify-center"
      style={{ background: color }}
    >
      {children}
    </div>
  );
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
