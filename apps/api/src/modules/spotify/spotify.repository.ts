import type { PrismaClient, SpotifyConnection } from "@prisma/client";

export type TokenUpdate = {
  accessToken:  string; // ciphertext — see backend-core/crypto/token-cipher.ts
  refreshToken: string; // ciphertext
  expiresAt:    Date;
  scope:        string;
};

export class SpotifyRepository {
  constructor(private prisma: PrismaClient) {}

  findByUserId(userId: string): Promise<SpotifyConnection | null> {
    return this.prisma.spotifyConnection.findUnique({ where: { userId } });
  }

  // First connect creates the row; re-authorizing (e.g. after a revoke)
  // replaces the tokens and clears needsReconnect — a clean slate.
  upsertConnection(userId: string, data: TokenUpdate): Promise<SpotifyConnection> {
    return this.prisma.spotifyConnection.upsert({
      where: { userId },
      create: { userId, ...data, showOnProfile: true, needsReconnect: false, connectedAt: new Date() },
      update: { ...data, needsReconnect: false, connectedAt: new Date() },
    });
  }

  updateTokens(userId: string, data: TokenUpdate): Promise<SpotifyConnection> {
    return this.prisma.spotifyConnection.update({ where: { userId }, data });
  }

  markNeedsReconnect(userId: string): Promise<SpotifyConnection> {
    return this.prisma.spotifyConnection.update({ where: { userId }, data: { needsReconnect: true } });
  }

  setShowOnProfile(userId: string, showOnProfile: boolean): Promise<SpotifyConnection> {
    return this.prisma.spotifyConnection.update({ where: { userId }, data: { showOnProfile } });
  }

  // deleteMany so disconnecting an account that was never connected is a no-op,
  // not a thrown "record not found".
  delete(userId: string): Promise<{ count: number }> {
    return this.prisma.spotifyConnection.deleteMany({ where: { userId } });
  }
}
