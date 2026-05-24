import type { MessageEmbed } from "@relay/contracts";
import { TwitterEmbed } from "./twitter-embed";
import { InstagramEmbed } from "./instagram-embed";
import { YoutubeEmbed } from "./youtube-embed";
import { TiktokEmbed } from "./tiktok-embed";
import { GenericEmbed } from "./generic-embed";

type Props = { embed: MessageEmbed; isMine: boolean };

export function EmbedCard({ embed, isMine }: Props) {
  switch (embed.provider) {
    case "twitter":   return <TwitterEmbed   embed={embed} isMine={isMine} />;
    case "instagram": return <InstagramEmbed embed={embed} isMine={isMine} />;
    case "youtube":   return <YoutubeEmbed   embed={embed} isMine={isMine} />;
    case "tiktok":    return <TiktokEmbed    embed={embed} isMine={isMine} />;
    default:          return <GenericEmbed   embed={embed} isMine={isMine} />;
  }
}
