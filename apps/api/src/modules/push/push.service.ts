import webpush from "web-push";
import type { PushSubscription as WebPushSubscription } from "web-push";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../backend-core/runtime/env.js";
import { PushRepository } from "./push.repository.js";

// Versioned wire payload (server emits, sw.js reads). Bump `v` and the SW can
// branch on format without breaking already-installed service workers.
export type PushPayload = {
  v:    1;
  type: "message" | "call_incoming" | "call_missed" | "call_cleared" | "test";
  title: string;
  body:  string;
  url?:  string;
  tag?:  string;
};

export type SendOptions = {
  ttl?:     number; // seconds the push service should hold an undeliverable message
  urgency?: "very-low" | "low" | "normal" | "high";
};

const DEFAULT_TTL = 4 * 60 * 60; // 4h — a stale message notification is still useful-ish

// VAPID is set process-wide and lazily, the first time we actually send, so the
// server boots fine with keys unset (push just skips).
let vapidReady = false;
export function isPushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}
function ensureVapid(): boolean {
  if (!isPushConfigured()) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
  return true;
}

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown }).statusCode;
  return typeof s === "number" ? s : 0;
}

export class PushService {
  private repo: PushRepository;
  constructor(private prisma: PrismaClient, private log: FastifyBaseLogger) {
    this.repo = new PushRepository(prisma);
  }

  // Fan a payload out to every device a user has registered. Bumps lastUsedAt on
  // success, prunes endpoints the push service reports as gone (404/410), and
  // emits one structured log line per call for delivery-health monitoring.
  async sendToUser(userId: string, payload: PushPayload, opts: SendOptions = {}): Promise<void> {
    if (!ensureVapid()) {
      this.log.info({ userId, type: payload.type }, "[push] skipped: VAPID not configured");
      return;
    }
    const subs = await this.repo.listForUser(userId);
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    const sendOpts = { TTL: opts.ttl ?? DEFAULT_TTL, urgency: opts.urgency ?? "normal" } as const;

    const touch: string[] = [];
    const prune: string[] = [];
    const errorCodes: Record<string, number> = {};

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription as unknown as WebPushSubscription, body, sendOpts);
          touch.push(s.id);
        } catch (err) {
          const status = statusOf(err);
          errorCodes[String(status)] = (errorCodes[String(status)] ?? 0) + 1;
          // 404 Not Found / 410 Gone = the subscription is dead; drop it.
          if (status === 404 || status === 410) prune.push(s.id);
        }
      }),
    );

    if (touch.length) await this.repo.touch(touch);
    if (prune.length) await this.repo.deleteByIds(prune);

    this.log.info(
      { userId, type: payload.type, sent: touch.length, pruned: prune.length, failed: subs.length - touch.length, errorCodes },
      "[push] sendToUser",
    );
  }
}
