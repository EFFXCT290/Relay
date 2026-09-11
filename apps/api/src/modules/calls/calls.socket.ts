import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";
import {
  CALL_EVENTS,
  type CallInitInbound,
  type CallByIdInbound,
  type CallSdpInbound,
  type CallIceInbound,
  type CallInitAck,
  type CallMediaStateInbound,
  type CallClientStateInbound,
  type CallConnectionStatsInbound,
} from "@relay/contracts";
import { CallService } from "./calls.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Call signaling socket layer — thin, like presence. NO withAck: signaling is
// ephemeral fire-and-forget (see calls.service.ts). call:init uses the Socket.IO
// ack callback so the caller learns its callId (or why it was refused).
//
// The disconnect handler is the safety net for refresh/crash/network-loss — it
// routes into the same terminate() path as an explicit hang-up.
// ─────────────────────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function registerCallSocket(
  socket:  Socket,
  fastify: FastifyInstance,
  userId:  string,
) {
  const service = new CallService(fastify);

  socket.on(
    CALL_EVENTS.INIT,
    (payload: CallInitInbound, ack?: (res: CallInitAck) => void) => {
      const respond = (res: CallInitAck) => { if (typeof ack === "function") ack(res); };
      if (!payload || !isNonEmptyString(payload.targetUserId)) {
        respond({ ok: false, reason: "error" });
        return;
      }
      void service
        .initiate(userId, payload, socket.id)
        .then(respond)
        .catch((err) => {
          fastify.log.error({ err }, "[call] initiate failed");
          respond({ ok: false, reason: "error" });
        });
    },
  );

  socket.on(CALL_EVENTS.ACCEPT, (payload: CallByIdInbound) => {
    if (!isNonEmptyString(payload?.callId)) return;
    void service.accept(userId, payload.callId, socket.id);
  });

  socket.on(CALL_EVENTS.REJECT, (payload: CallByIdInbound) => {
    if (!isNonEmptyString(payload?.callId)) return;
    void service.reject(userId, payload.callId);
  });

  socket.on(CALL_EVENTS.END, (payload: CallByIdInbound) => {
    if (!isNonEmptyString(payload?.callId)) return;
    void service.end(userId, payload.callId);
  });

  socket.on(CALL_EVENTS.OFFER, (payload: CallSdpInbound) => {
    if (!isNonEmptyString(payload?.callId) || !payload?.sdp) return;
    service.relayOffer(userId, payload);
  });

  socket.on(CALL_EVENTS.ANSWER, (payload: CallSdpInbound) => {
    if (!isNonEmptyString(payload?.callId) || !payload?.sdp) return;
    service.relayAnswer(userId, payload);
  });

  socket.on(CALL_EVENTS.ICE, (payload: CallIceInbound) => {
    if (!isNonEmptyString(payload?.callId) || !payload?.candidate) return;
    service.relayIce(userId, payload);
  });

  socket.on(CALL_EVENTS.MEDIA_STATE, (payload: CallMediaStateInbound) => {
    if (!isNonEmptyString(payload?.callId) || typeof payload?.cameraOn !== "boolean") return;
    service.relayMediaState(userId, payload);
  });

  // ── Observability only (Part 2/3) ─────────────────────────────────────────
  // Pure logging sinks — no callRuntime lookup, no relay, no side effects. The
  // client sends these best-effort; a malformed/missing callId is silently
  // dropped rather than logged, same guard style as every handler above.
  socket.on(CALL_EVENTS.CLIENT_STATE, (payload: CallClientStateInbound) => {
    if (!isNonEmptyString(payload?.callId)) return;
    fastify.log.info(
      {
        callId:               payload.callId,
        userId,
        state:                payload.state,
        clientTimestamp:      payload.timestamp,
        iceRestartAttempted:  payload.iceRestartAttempted ?? false,
        iceRestartBy:         payload.iceRestartBy ?? null,
        outcome:              payload.outcome ?? null,
      },
      "[call] client-state",
    );
  });

  socket.on(CALL_EVENTS.CONNECTION_STATS, (payload: CallConnectionStatsInbound) => {
    if (!isNonEmptyString(payload?.callId)) return;
    // debug level: this fires every ~5-10s for the length of every call, unlike
    // the low-frequency signaling/state-transition events above.
    fastify.log.debug(
      {
        callId:              payload.callId,
        userId,
        candidateType:       payload.candidateType,
        bytesSentDelta:      payload.bytesSentDelta,
        bytesReceivedDelta:  payload.bytesReceivedDelta,
        packetLoss:          payload.packetLoss ?? null,
      },
      "[call] connection-stats",
    );
  });

  socket.on("disconnect", () => {
    void service.handleDisconnect(userId, socket.id);
  });
}
