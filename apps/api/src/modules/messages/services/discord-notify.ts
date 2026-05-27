const WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL;
const ALERT_UID    = process.env.DISCORD_ALERT_USER_ID;

interface NotifyOptions {
  senderUsername: string;
  body:           string | null;
  messageType:    "TEXT" | "IMAGE" | "VIDEO" | "AUDIO";
  recipientIds:   string[];
  onlineIds:      string[];
}

export async function maybeNotifyDiscord(opts: NotifyOptions): Promise<void> {
  if (!WEBHOOK_URL || !ALERT_UID) return;
  if (!opts.recipientIds.includes(ALERT_UID)) return;
  // Skip if you're online — you'll see it in real-time.
  if (opts.onlineIds.includes(ALERT_UID)) return;

  const preview =
    opts.messageType === "TEXT" && opts.body
      ? opts.body.length > 120
        ? opts.body.slice(0, 120) + "…"
        : opts.body
      : opts.messageType === "IMAGE"  ? "📷 Image"
      : opts.messageType === "VIDEO"  ? "🎥 Video"
      : opts.messageType === "AUDIO"  ? "🎙️ Voice note"
      : "(message)";

  try {
    await fetch(WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title:       "New Relay message",
            description: preview,
            footer:      { text: opts.senderUsername },
            color:       0x5865f2,
          },
        ],
      }),
    });
  } catch {
    // best-effort — never let a Discord failure affect message delivery
  }
}
