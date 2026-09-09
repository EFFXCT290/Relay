import type { PrismaClient, UserNickname } from "@prisma/client";

export class NicknameRepository {
  constructor(private prisma: PrismaClient) {}

  findOne(ownerId: string, targetUserId: string): Promise<UserNickname | null> {
    return this.prisma.userNickname.findUnique({
      where: { ownerId_targetUserId: { ownerId, targetUserId } },
    });
  }

  upsert(
    ownerId: string,
    targetUserId: string,
    nickname: string,
    sharedWithTarget: boolean,
  ): Promise<UserNickname> {
    return this.prisma.userNickname.upsert({
      where: { ownerId_targetUserId: { ownerId, targetUserId } },
      create: { ownerId, targetUserId, nickname, sharedWithTarget },
      update: { nickname, sharedWithTarget },
    });
  }

  // deleteMany so clearing a nickname that was never set is a no-op, not a
  // thrown "record not found" — same convention as SpotifyRepository.delete.
  delete(ownerId: string, targetUserId: string): Promise<{ count: number }> {
    return this.prisma.userNickname.deleteMany({ where: { ownerId, targetUserId } });
  }

  // Batched "my nickname for each of these people" — for the conversation
  // list/detail Promise.all fan-out (see conversation.routes.ts).
  findManyByOwner(ownerId: string, targetUserIds: string[]): Promise<UserNickname[]> {
    if (targetUserIds.length === 0) return Promise.resolve([]);
    return this.prisma.userNickname.findMany({
      where: { ownerId, targetUserId: { in: targetUserIds } },
    });
  }

  // Batched "who among these owners has shared a nickname with me" — the
  // reverse-direction "X calls you: Y" lookup.
  findManySharedWithTarget(targetUserId: string, ownerIds: string[]): Promise<UserNickname[]> {
    if (ownerIds.length === 0) return Promise.resolve([]);
    return this.prisma.userNickname.findMany({
      where: { targetUserId, ownerId: { in: ownerIds }, sharedWithTarget: true },
    });
  }

  // Batched "each of these owners' own private nickname for ONE fixed
  // target" — the mirror of findManyByOwner (one owner, many targets). Used
  // to resolve a sender's per-recipient display name for disappearing-
  // message notification placeholders: no sharedWithTarget filter, same as
  // findManyByOwner — a private, unshared nickname still governs what its
  // OWNER sees.
  findManyByTarget(ownerIds: string[], targetUserId: string): Promise<UserNickname[]> {
    if (ownerIds.length === 0) return Promise.resolve([]);
    return this.prisma.userNickname.findMany({
      where: { targetUserId, ownerId: { in: ownerIds } },
    });
  }
}
