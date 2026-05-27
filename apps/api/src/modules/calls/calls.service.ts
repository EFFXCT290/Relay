import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  CALL_EVENTS,
  CALL_RING_TIMEOUT_MS,
  type CallEventName,
  type CallInitAck,
  type CallInitInbound,
  type CallRingingEvent,
  type CallStatus,
  type CallSdpInbound,
  type CallIceInbound,
} from "@relay/contracts";
import { PresenceService } from "../presence/presence.service.js";
import { CallRepository } from "./calls.repository.js";
import { callRuntime, type ActiveCallSession } from "./calls.runtime.js";
import { callDebug } from "./calls.debug.js";

// ─────────────────────────────────────────────────────────────────────────────
// Call orchestration. Signaling is fire-and-forget over user rooms (raw emit,
// like presence) — NEVER the reliability layer; replaying SDP/ICE against a
// torn-down peer connection is the canonical source of ghost-call bugs.
//
// Cleanup discipline: EVERY terminal path (reject, end, ring timeout, both
// flavors of disconnect) funnels through the single terminate() routine. It is
// idempotent (keyed on the runtime session existing), so double-fires — e.g. a
// disconnect racing an explicit end, or a stale ring timer firing after answer
// — collapse to one DB write and one teardown. No terminal logic lives anywhere
// else.
// ─────────────────────────────────────────────────────────────────────────────

export class CallService {
  private repo: CallRepository;

  constructor(private fastify: FastifyInstance) {
    this.repo = new CallRepository(fastify);
  }

  private emitTo(userId: string, event: CallEventName, payload: unknown): void {
    this.fastify.io.to(`user:${userId}`).emit(event, payload);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initiate(callerId: string, input: CallInitInbound): Promise<CallInitAck> {
    const { targetUserId, type, conversationId } = input;

    if (targetUserId === callerId) return { ok: false, reason: "self" };
    if (type !== "AUDIO" && type !== "VIDEO") return { ok: false, reason: "error" };

    const [recipient, caller] = await Promise.all([
      this.fastify.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } }),
      this.fastify.prisma.user.findUnique({ where: { id: callerId }, select: { username: true } }),
    ]);
    if (!recipient) return { ok: false, reason: "not_found" };

    const presence = await new PresenceService(this.fastify).getFor(targetUserId);
    if (!presence.isOnline) return { ok: false, reason: "offline" };

    // Reserve both slots synchronously (no await between the check and create)
    // so a concurrent initiate for either party loses the race and gets "busy".
    if (callRuntime.isBusy(callerId) || callRuntime.isBusy(targetUserId)) {
      return { ok: false, reason: "busy" };
    }
    const callId = randomUUID();
    const session: ActiveCallSession = {
      callId,
      callerId,
      recipientId: targetUserId,
      type,
      state: "ringing",
    };
    callRuntime.create(session);

    try {
      await this.repo.createRinging({ id: callId, callerId, recipientId: targetUserId, type, conversationId });
    } catch (err) {
      callRuntime.destroy(callId);
      this.fastify.log.error({ err, callId }, "call: createRinging failed");
      return { ok: false, reason: "error" };
    }

    // Arm the unanswered → MISSED timer. unref so a pending ring never holds the
    // process open during shutdown (matches presence's offline timers).
    session.ringTimer = setTimeout(() => {
      void this.terminate(callId, { status: "MISSED", event: CALL_EVENTS.TIMEOUT, notify: [callerId, targetUserId] });
    }, CALL_RING_TIMEOUT_MS);
    session.ringTimer.unref?.();

    const ringing: CallRingingEvent = {
      callId,
      caller: { id: callerId, username: caller?.username ?? "" },
      type,
      conversationId,
    };
    this.emitTo(targetUserId, CALL_EVENTS.RINGING, ringing);
    callDebug(this.fastify.log, "ringing", { callId, callerId, recipientId: targetUserId, type });
    return { ok: true, callId };
  }

  async accept(userId: string, callId: string): Promise<void> {
    const session = callRuntime.get(callId);
    if (!session || session.recipientId !== userId || session.state !== "ringing") return;

    if (session.ringTimer) {
      clearTimeout(session.ringTimer);
      session.ringTimer = undefined;
    }
    await this.repo.markAnswered(callId);
    session.state = "active";
    session.answeredAt = Date.now();

    this.emitTo(session.callerId, CALL_EVENTS.ACCEPTED, { callId });
    callDebug(this.fastify.log, "ringing → active", { callId, acceptedBy: userId });
  }

  // ── Signaling relay (verbatim, to the other peer) ───────────────────────────

  relayOffer(userId: string, input: CallSdpInbound): void {
    const session = callRuntime.get(input.callId);
    if (!session || !callRuntime.isParticipant(session, userId)) return;
    this.emitTo(callRuntime.peerOf(session, userId), CALL_EVENTS.OFFER, input);
    callDebug(this.fastify.log, "relay offer", { callId: input.callId, from: userId });
  }

  relayAnswer(userId: string, input: CallSdpInbound): void {
    const session = callRuntime.get(input.callId);
    if (!session || !callRuntime.isParticipant(session, userId)) return;
    this.emitTo(callRuntime.peerOf(session, userId), CALL_EVENTS.ANSWER, input);
    callDebug(this.fastify.log, "relay answer", { callId: input.callId, from: userId });
  }

  relayIce(userId: string, input: CallIceInbound): void {
    const session = callRuntime.get(input.callId);
    if (!session || !callRuntime.isParticipant(session, userId)) return;
    this.emitTo(callRuntime.peerOf(session, userId), CALL_EVENTS.ICE, input);
  }

  // ── Terminal paths (all funnel through terminate) ───────────────────────────

  async reject(userId: string, callId: string): Promise<void> {
    const session = callRuntime.get(callId);
    if (!session || session.recipientId !== userId) return;
    await this.terminate(callId, {
      status: "REJECTED",
      endedByUserId: userId,
      event: CALL_EVENTS.ENDED,
      notify: [session.callerId],
    });
  }

  async end(userId: string, callId: string): Promise<void> {
    const session = callRuntime.get(callId);
    if (!session || !callRuntime.isParticipant(session, userId)) return;
    await this.terminate(callId, {
      status: "ENDED",
      endedByUserId: userId,
      event: CALL_EVENTS.ENDED,
      notify: [callRuntime.peerOf(session, userId)],
    });
  }

  // Socket dropped (refresh, crash, network loss). Resolves whatever call this
  // user was in, in whatever state.
  async handleDisconnect(userId: string): Promise<void> {
    const session = callRuntime.getByUser(userId);
    if (!session) return;
    const peer = callRuntime.peerOf(session, userId);

    if (session.state === "active") {
      await this.terminate(session.callId, {
        status: "FAILED",
        endedByUserId: userId,
        event: CALL_EVENTS.FAILED,
        notify: [peer],
      });
    } else {
      // Disconnected while still ringing — never connected → MISSED, and stop
      // the peer's UI (caller's outgoing ring or recipient's incoming modal).
      await this.terminate(session.callId, {
        status: "MISSED",
        event: CALL_EVENTS.ENDED,
        notify: [peer],
      });
    }
  }

  // The single idempotent cleanup routine. First caller wins: it writes the
  // terminal row, tears down the runtime session, and notifies. Any later call
  // finds no session and no-ops — so a disconnect racing an explicit end (or a
  // stale ring timer) can never double-write or double-emit.
  private async terminate(
    callId: string,
    opts: {
      status: CallStatus;
      endedByUserId?: string | null;
      event: CallEventName;
      notify: string[];
    },
  ): Promise<void> {
    const session = callRuntime.get(callId);
    if (!session) {
      // Idempotent no-op — a later terminal path lost the race. Tracing this
      // makes double-fires (disconnect vs. explicit end, stale ring timer)
      // visible instead of invisible.
      callDebug(this.fastify.log, "terminate (no-op, already gone)", { callId, status: opts.status });
      return;
    }

    const durationSec = session.answeredAt
      ? Math.round((Date.now() - session.answeredAt) / 1000)
      : 0;
    callDebug(this.fastify.log, "terminate", {
      callId,
      status: opts.status,
      fromState: session.state,
      durationSec,
      endedByUserId: opts.endedByUserId ?? null,
    });

    try {
      await this.repo.markEnded(callId, opts.status, durationSec, opts.endedByUserId);
    } catch (err) {
      this.fastify.log.error({ err, callId }, "call: markEnded failed");
    }
    callRuntime.destroy(callId);

    const payload = { callId, status: opts.status };
    for (const uid of opts.notify) this.emitTo(uid, opts.event, payload);
  }
}
