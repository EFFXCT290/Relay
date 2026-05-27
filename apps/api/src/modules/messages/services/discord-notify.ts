interface NotifyOptions {
  senderUsername: string;
  body:           string | null;
  messageType:    "TEXT" | "IMAGE" | "VIDEO" | "AUDIO";
  recipientIds:   string[];
  onlineIds:      string[];
  log:            { info: (obj: object, msg: string) => void };
}

export async function maybeNotifyDiscord(opts: NotifyOptions): Promise<void> {
  // Read at call time so a server restart is not required after .env edits.
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const alertUid   = process.env.DISCORD_ALERT_USER_ID;

  if (!webhookUrl || !alertUid) {
    opts.log.info({ webhookUrl: !!webhookUrl, alertUid: !!alertUid }, "[discord] skipped: env vars not set");
    return;
  }
  if (!opts.recipientIds.includes(alertUid)) {
    opts.log.info({ alertUid, recipientIds: opts.recipientIds }, "[discord] skipped: alert user is not a recipient");
    return;
  }
  if (opts.onlineIds.includes(alertUid)) {
    opts.log.info({ alertUid }, "[discord] skipped: alert user is online");
    return;
  }

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
    const res = await fetch(webhookUrl, {
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
    opts.log.info({ status: res.status }, "[discord] webhook sent");
  } catch (err) {
    opts.log.info({ err }, "[discord] webhook fetch failed");
  }
}
