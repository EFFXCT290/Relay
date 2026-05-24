import type { MessageEmbed } from "@relay/contracts";
import { CardShell, ImageBanner, AccentStrip } from "./_card-shell";

// Camera outline — close enough to Instagram's visual identity without a full SVG logo.
const InstagramIcon = () => (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="white"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
  </svg>
);

type Props = { embed: MessageEmbed; isMine: boolean };

export function InstagramEmbed({ embed, isMine }: Props) {
  return (
    <CardShell embed={embed} isMine={isMine}>
      {embed.imageUrl ? (
        <ImageBanner src={embed.imageUrl} alt={embed.title ?? "Instagram post"} />
      ) : (
        <AccentStrip color="#833AB4">
          <InstagramIcon />
        </AccentStrip>
      )}
    </CardShell>
  );
}
