import type { MessageEmbed } from "@relay/contracts";
import { CardShell, ImageBanner, AccentStrip } from "./_card-shell";

// i.ytimg.com is the authoritative YouTube thumbnail CDN — far more reliable than
// whatever OG image the scraper returned. hqdefault is 480×360 and always exists
// for any public video.
function ytThumbnail(url: string): string | null {
  try {
    const videoId = new URL(url).searchParams.get("v");
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}

const PlayOverlay = () => (
  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
    <div
      className="flex h-10 w-10 items-center justify-center rounded-full"
      style={{ background: "rgba(0,0,0,0.65)" }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden>
        <path d="M8 5v14l11-7z" />
      </svg>
    </div>
  </div>
);

const YouTubeIcon = () => (
  <svg width="34" height="24" viewBox="0 0 34 24" fill="none" aria-hidden>
    <rect width="34" height="24" rx="5" fill="#FF0000" />
    <path d="M14 8l9 4.5-9 4.5V8z" fill="white" />
  </svg>
);

type Props = { embed: MessageEmbed; isMine: boolean };

export function YoutubeEmbed({ embed, isMine }: Props) {
  // Prefer the reliable CDN thumbnail; fall back to whatever OG image we scraped.
  const thumbnailSrc = ytThumbnail(embed.url) ?? embed.imageUrl;

  return (
    <CardShell embed={embed} isMine={isMine}>
      {thumbnailSrc ? (
        <ImageBanner
          src={thumbnailSrc}
          alt={embed.title ?? "YouTube video"}
          overlay={<PlayOverlay />}
        />
      ) : (
        <AccentStrip color="#FF0000">
          <YouTubeIcon />
        </AccentStrip>
      )}
    </CardShell>
  );
}
