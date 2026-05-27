import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";
import {
  CALL_EVENTS,
  type CallInitInbound,
  type CallByIdInbound,
  type CallSdpInbound,
  type CallIceInbound,
  type CallInitAck,
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
        .initiate(userId, payload)
        .then(respond)
        .catch((err) => {
          fastify.log.error({ err }, "call: initiate failed");
          respond({ ok: false, reason: "error" });
        });
    },
  );

  socket.on(CALL_EVENTS.ACCEPT, (payload: CallByIdInbound) => {
    if (!isNonEmptyString(payload?.callId)) return;
    void service.accept(userId, payload.callId);
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

  socket.on("disconnect", () => {
    void service.handleDisconnect(userId);
  });
}
