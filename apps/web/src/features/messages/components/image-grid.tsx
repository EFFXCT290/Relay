import type { MessageAttachment } from "@relay/contracts";
import { ImageBubble } from "./image-bubble";

type Props = {
  attachments: MessageAttachment[];
  isMine:      boolean;
};

// Phase 1: single image. Grid layout for multiple images comes later.
export function ImageGrid({ attachments, isMine }: Props) {
  if (attachments.length === 0) return null;
  return <ImageBubble attachment={attachments[0]!} isMine={isMine} />;
}
