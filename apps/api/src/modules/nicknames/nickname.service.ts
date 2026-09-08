import type { FastifyInstance } from "fastify";
import type { UserNickname } from "@prisma/client";
import { USER_NICKNAME_EVENTS, type UserNicknameSharedUpdatedEvent } from "@relay/contracts";
import { NicknameRepository } from "./nickname.repository.js";
import { notify } from "../notifications/notification.service.js";

// The value the TARGET can actually see right now — null whether the nickname
// was never shared, was explicitly unshared, or was never set at all. The
// target never needs to distinguish those.
function effectiveVisible(row: UserNickname | null): string | null {
  return row && row.sharedWithTarget ? row.nickname : null;
}

export class NicknameService {
  private repo: NicknameRepository;

  constructor(private fastify: FastifyInstance) {
    this.repo = new NicknameRepository(fastify.prisma);
  }

  async getMyNicknameFor(ownerId: string, targetUserId: string): Promise<{ nickname: string | null; sharedWithTarget: boolean }> {
    const row = await this.repo.findOne(ownerId, targetUserId);
    return { nickname: row?.nickname ?? null, sharedWithTarget: row?.sharedWithTarget ?? false };
  }

  // Set/update. Fires a NICKNAME_SHARED alert AND the realtime
  // user:nickname-shared-updated event to the target — but only on a
  // genuinely new share action or a changed nickname while already shared,
  // never on an idempotent re-save. See the shouldNotify derivation below;
  // it is the one place that decision is made, so the two effects (alert +
  // live update) can never disagree about when a "share" actually happened.
  async setNickname(
    ownerId: string,
    targetUserId: string,
    nickname: string,
    sharedWithTarget: boolean,
  ): Promise<{ nickname: string; sharedWithTarget: boolean }> {
    const previous = await this.repo.findOne(ownerId, targetUserId);
    const wasShared = previous?.sharedWithTarget ?? false;
    const nicknameChanged = previous?.nickname !== nickname;

    await this.repo.upsert(ownerId, targetUserId, nickname, sharedWithTarget);

    // A genuinely new share (wasn't shared before) OR the nickname changed
    // while it was already shared. Turning sharing OFF, or re-saving the same
    // nickname with sharing already on, is never a notify-worthy event.
    const shouldNotify = sharedWithTarget && (!wasShared || nicknameChanged);

    const nextVisible = sharedWithTarget ? nickname : null;
    const prevVisible = effectiveVisible(previous);
    if (nextVisible !== prevVisible) {
      this.emitSharedUpdated(ownerId, targetUserId, nextVisible);
    }

    if (shouldNotify) {
      const owner = await this.fastify.prisma.user.findUnique({ where: { id: ownerId }, select: { username: true } });
      await notify(this.fastify, targetUserId, "NICKNAME_SHARED", {
        from:     { userId: ownerId, username: owner?.username ?? "" },
        nickname,
      });
    }

    return { nickname, sharedWithTarget };
  }

  // Clearing always reverts the owner's own view immediately (repository
  // delete does that unconditionally); if it was shared, the target's live
  // badge must disappear immediately too — no alert though, clearing was
  // never a "share" action.
  async clearNickname(ownerId: string, targetUserId: string): Promise<void> {
    const previous = await this.repo.findOne(ownerId, targetUserId);
    await this.repo.delete(ownerId, targetUserId);
    if (previous?.sharedWithTarget) {
      this.emitSharedUpdated(ownerId, targetUserId, null);
    }
  }

  private emitSharedUpdated(ownerId: string, targetUserId: string, nickname: string | null): void {
    const event: UserNicknameSharedUpdatedEvent = { ownerId, nickname };
    this.fastify.io.to(`user:${targetUserId}`).emit(USER_NICKNAME_EVENTS.SHARED_UPDATED, event);
  }

  // Batched "my nickname for each of these people" — mirrors
  // conversation.routes.ts's spotifySummariesFor() exactly: same Map-keyed-
  // by-userId shape, same Promise.all-friendly single-batch-query fan-out.
  async myNicknamesFor(ownerId: string, targetUserIds: string[]): Promise<Map<string, string>> {
    if (targetUserIds.length === 0) return new Map();
    const rows = await this.repo.findManyByOwner(ownerId, [...new Set(targetUserIds)]);
    return new Map(rows.map((r) => [r.targetUserId, r.nickname]));
  }

  // Batched "who among these owners has shared a nickname with me" — the
  // reverse-direction lookup for the "X calls you: Y" badge.
  async sharedNicknamesForMe(targetUserId: string, ownerIds: string[]): Promise<Map<string, string>> {
    if (ownerIds.length === 0) return new Map();
    const rows = await this.repo.findManySharedWithTarget(targetUserId, [...new Set(ownerIds)]);
    return new Map(rows.map((r) => [r.ownerId, r.nickname]));
  }
}
