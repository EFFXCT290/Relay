import type { MessageEmbed } from "@relay/contracts";
import { CardShell, ImageBanner, AccentStrip } from "./_card-shell";

const XIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="white" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

type Props = { embed: MessageEmbed; isMine: boolean };

export function TwitterEmbed({ embed, isMine }: Props) {
  return (
    <CardShell embed={embed} isMine={isMine} descriptionLines={3}>
      {embed.imageUrl ? (
        <ImageBanner src={embed.imageUrl} alt={embed.title ?? "X post"} />
      ) : (
        <AccentStrip color="#000000">
          <XIcon />
        </AccentStrip>
      )}
    </CardShell>
  );
}
