// Realtime event helpers for the media domain.
import type { Server as IOServer } from "socket.io";
import { MEDIA_EVENTS, type MediaReadyEvent } from "@relay/contracts";

export function emitMediaReady(io: IOServer, uploaderId: string, event: MediaReadyEvent) {
  io.to(`user:${uploaderId}`).emit(MEDIA_EVENTS.READY, event);
}
