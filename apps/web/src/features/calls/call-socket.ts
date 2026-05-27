import type { Socket } from "socket.io-client";
import {
  CALL_EVENTS,
  CALL_RING_TIMEOUT_MS,
  type CallInitInbound,
  type CallInitAck,
  type CallByIdInbound,
  type CallSdpInbound,
  type CallIceInbound,
  type CallRingingEvent,
  type CallAcceptedEvent,
  type CallSdpEvent,
  type CallIceEvent,
  type CallTimeoutEvent,
  type CallEndedEvent,
  type CallFailedEvent,
} from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Thin client signaling layer. bindCallSocket registers NAMED handlers (so they
// can be removed exactly) and returns a cleanup that off()s every one — this is
// what prevents duplicate listeners after a reconnect. Emits are fire-and-forget
// except call:init, which uses the ack callback to learn the callId.
// ─────────────────────────────────────────────────────────────────────────────

export type CallSocketHandlers = {
  onRinging:  (e: CallRingingEvent) => void;
  onAccepted: (e: CallAcceptedEvent) => void;
  onOffer:    (e: CallSdpEvent) => void;
  onAnswer:   (e: CallSdpEvent) => void;
  onIce:      (e: CallIceEvent) => void;
  onTimeout:  (e: CallTimeoutEvent) => void;
  onEnded:    (e: CallEndedEvent) => void;
  onFailed:   (e: CallFailedEvent) => void;
};

export function bindCallSocket(socket: Socket, h: CallSocketHandlers): () => void {
  socket.on(CALL_EVENTS.RINGING,  h.onRinging);
  socket.on(CALL_EVENTS.ACCEPTED, h.onAccepted);
  socket.on(CALL_EVENTS.OFFER,    h.onOffer);
  socket.on(CALL_EVENTS.ANSWER,   h.onAnswer);
  socket.on(CALL_EVENTS.ICE,      h.onIce);
  socket.on(CALL_EVENTS.TIMEOUT,  h.onTimeout);
  socket.on(CALL_EVENTS.ENDED,    h.onEnded);
  socket.on(CALL_EVENTS.FAILED,   h.onFailed);

  return () => {
    socket.off(CALL_EVENTS.RINGING,  h.onRinging);
    socket.off(CALL_EVENTS.ACCEPTED, h.onAccepted);
    socket.off(CALL_EVENTS.OFFER,    h.onOffer);
    socket.off(CALL_EVENTS.ANSWER,   h.onAnswer);
    socket.off(CALL_EVENTS.ICE,      h.onIce);
    socket.off(CALL_EVENTS.TIMEOUT,  h.onTimeout);
    socket.off(CALL_EVENTS.ENDED,    h.onEnded);
    socket.off(CALL_EVENTS.FAILED,   h.onFailed);
  };
}

// ── Emit helpers ─────────────────────────────────────────────────────────────

export function emitInit(socket: Socket, payload: CallInitInbound): Promise<CallInitAck> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res: CallInitAck) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    socket.emit(CALL_EVENTS.INIT, payload, settle);
    // Fallback so the caller never hangs if the ack is lost (e.g. server dropped).
    setTimeout(() => settle({ ok: false, reason: "error" }), CALL_RING_TIMEOUT_MS);
  });
}

export function emitAccept(socket: Socket, payload: CallByIdInbound): void {
  socket.emit(CALL_EVENTS.ACCEPT, payload);
}
export function emitReject(socket: Socket, payload: CallByIdInbound): void {
  socket.emit(CALL_EVENTS.REJECT, payload);
}
export function emitEnd(socket: Socket, payload: CallByIdInbound): void {
  socket.emit(CALL_EVENTS.END, payload);
}
export function emitOffer(socket: Socket, payload: CallSdpInbound): void {
  socket.emit(CALL_EVENTS.OFFER, payload);
}
export function emitAnswer(socket: Socket, payload: CallSdpInbound): void {
  socket.emit(CALL_EVENTS.ANSWER, payload);
}
export function emitIce(socket: Socket, payload: CallIceInbound): void {
  socket.emit(CALL_EVENTS.ICE, payload);
}
