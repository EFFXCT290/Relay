import type { MessageEmbed } from "@relay/contracts";
import { CardShell, ImageBanner, AccentStrip } from "./_card-shell";

// TikTok's stylised music note — their primary brand symbol.
const TikTokIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="white" aria-hidden>
    <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V9.97a8.16 8.16 0 004.77 1.52V8.03a4.85 4.85 0 01-1-.34z" />
  </svg>
);

type Props = { embed: MessageEmbed; isMine: boolean };

export function TiktokEmbed({ embed, isMine }: Props) {
  return (
    <CardShell embed={embed} isMine={isMine}>
      {embed.imageUrl ? (
        <ImageBanner src={embed.imageUrl} alt={embed.title ?? "TikTok"} />
      ) : (
        <AccentStrip color="#010101">
          <TikTokIcon />
        </AccentStrip>
      )}
    </CardShell>
  );
}
