import type { FastifyInstance } from "fastify";
import { Prisma, type NotificationType, type Notification } from "@prisma/client";

// Only file in the notifications module that may touch Prisma.
export class NotificationRepository {
  constructor(private fastify: FastifyInstance) {}

  create(userId: string, type: NotificationType, payload: Record<string, unknown>): Promise<Notification> {
    return this.fastify.prisma.notification.create({
      // Prisma's InputJsonValue can't structurally match Record<string, unknown>
      // (unknown isn't assignable to its recursive variant). Cast at the seam.
      data: { userId, type, payload: payload as Prisma.InputJsonValue },
    });
  }
}
