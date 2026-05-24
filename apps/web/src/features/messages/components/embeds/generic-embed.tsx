import type { MessageEmbed } from "@relay/contracts";
import { CardShell, ImageBanner, AccentStrip, hostname } from "./_card-shell";

// A small lookup of accent colors for common non-social sites.
function accentColor(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h === "reddit.com") return "#FF4500";
    if (h === "github.com" || h === "gist.github.com") return "#24292e";
    if (h === "open.spotify.com") return "#1DB954";
    if (h === "twitch.tv") return "#9146FF";
    if (h === "discord.com" || h === "discord.gg") return "#5865F2";
  } catch { /* */ }
  return "rgba(255,255,255,0.08)";
}

type Props = { embed: MessageEmbed; isMine: boolean };

export function GenericEmbed({ embed, isMine }: Props) {
  const letter = (embed.siteName ?? hostname(embed.url))[0]?.toUpperCase() ?? "?";
  return (
    <CardShell embed={embed} isMine={isMine}>
      {embed.imageUrl ? (
        <ImageBanner src={embed.imageUrl} alt={embed.title ?? ""} />
      ) : (
        <AccentStrip color={accentColor(embed.url)}>
          <span className="text-[18px] font-bold text-white/80">{letter}</span>
        </AccentStrip>
      )}
    </CardShell>
  );
}
