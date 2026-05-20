import type { FastifyInstance } from "fastify";
import type { NotificationType } from "@prisma/client";
import { NOTIFICATION_EVENTS } from "@relay/contracts";
import { NotificationRepository } from "./notification.repository.js";

// Domain logic for notifications. Single seam for "create + broadcast" — every
// path that produces a Notification goes through here so we cannot accidentally
// insert one without firing the WS event (or vice versa).
export class NotificationService {
  private repo: NotificationRepository;

  constructor(private fastify: FastifyInstance) {
    this.repo = new NotificationRepository(fastify);
  }

  async notify(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const created = await this.repo.create(userId, type, payload);

    this.fastify.io.to(`user:${userId}`).emit(NOTIFICATION_EVENTS.NEW, {
      notification: {
        notificationId: created.id,
        type:           created.type,
        isRead:         created.isRead,
        payload:        created.payload,
        createdAt:      created.createdAt.toISOString(),
      },
    });
  }
}

// Convenience wrapper preserving the prior call site shape:
//   await notify(fastify, userId, "SYSTEM_ALERT", {...})
// Lets dev seeds and other callers stay terse without instantiating the service.
export async function notify(
  fastify: FastifyInstance,
  userId:  string,
  type:    NotificationType,
  payload: Record<string, unknown>,
): Promise<void> {
  await new NotificationService(fastify).notify(userId, type, payload);
}
