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
  type CallMediaStateInbound,
} from "@relay/contracts";
import { PresenceService } from "../presence/presence.service.js";
import { CallRepository } from "./calls.repository.js";
import { callRuntime, type ActiveCallSession } from "./calls.runtime.js";
import { callDebug } from "./calls.debug.js";
import { generateTurnCredentials } from "./turn.helper.js";
import { PushRepository } from "../push/push.repository.js";
import type { PushPayload } from "../push/push.service.js";
import { pushQueue, SEND_PUSH_JOB } from "../../queues/push.queue.js";
import { isNotificationProviderEnabled } from "../../backend-core/runtime/env.js";

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

    // Presence no longer hard-gates the attempt (it used to reject offline
    // callees before any session existed — see calls.service.ts history). An
    // offline callee still gets a real RINGING session + timer; delivery just
    // falls back to push instead of a live socket emit, decided below.
    const presence = await new PresenceService(this.fastify).getFor(targetUserId);
    const isOnline = presence.isOnline;

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
      conversationId,
      callerUsername: caller?.username ?? "",
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

    // Mint per-peer TURN credentials (own userId for coturn-log traceability) so
    // each side builds its peer connection with relay support. Falls back to
    // STUN-only when TURN is unconfigured — see turn.helper.ts.
    const ringing: CallRingingEvent = {
      callId,
      caller: { id: callerId, username: caller?.username ?? "" },
      type,
      conversationId,
      iceServers: generateTurnCredentials(targetUserId).iceServers,
    };
    if (isOnline) {
      this.emitTo(targetUserId, CALL_EVENTS.RINGING, ringing);
    } else {
      session.pushNotified = true;
      void this.pushIncomingCall(session, ringing.caller.username);
    }
    callDebug(this.fastify.log, "ringing", { callId, callerId, recipientId: targetUserId, type, isOnline });
    return { ok: true, callId, iceServers: generateTurnCredentials(callerId).iceServers };
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

  // Called on every new socket connection (plugins/socket.ts), mirroring
  // MessageService.sweepUndelivered. Closes the gap where a device that was
  // never live for the original RINGING emit (offline at initiate(), woken by
  // a push) would otherwise reconnect into a dead app with no way to learn a
  // call is still ringing for it. No-ops if there's nothing to resync.
  resyncRinging(userId: string): void {
    const session = callRuntime.getByUser(userId);
    if (!session || session.state !== "ringing" || session.recipientId !== userId) return;
    const ringing: CallRingingEvent = {
      callId: session.callId,
      caller: { id: session.callerId, username: session.callerUsername ?? "" },
      type: session.type,
      conversationId: session.conversationId,
      iceServers: generateTurnCredentials(userId).iceServers,
    };
    this.emitTo(userId, CALL_EVENTS.RINGING, ringing);
    callDebug(this.fastify.log, "ringing resync", { callId: session.callId, userId });
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

  // UI-state hint (Phase 7D). Relayed verbatim to the other peer so they can
  // show a "camera off" badge instead of a black frame. Ephemeral, fire-and-
  // forget, identical envelope to ICE — no DB write, no reliability layer.
  relayMediaState(userId: string, input: CallMediaStateInbound): void {
    const session = callRuntime.get(input.callId);
    if (!session || !callRuntime.isParticipant(session, userId)) return;
    this.emitTo(callRuntime.peerOf(session, userId), CALL_EVENTS.PEER_MEDIA_STATE, input);
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

    // Missed-call follow-up fires regardless of how the original ring was
    // delivered (live or push) — a recipient who was online but simply never
    // answered still deserves to know. A stale "incoming call" notification
    // (only ever sent when pushNotified) is superseded by this same tag, via
    // sw.js's existing renotify mechanism — no separate clear needed.
    if (opts.status === "MISSED") {
      void this.pushMissedCall(session.recipientId, session.callId, session.callerUsername ?? "");
    } else if (session.pushNotified) {
      // Recipient resolved the call some other way (answered elsewhere,
      // rejected, ended, failed) — the device we push-notified never showed a
      // live UI for it, so its stale notification needs an explicit close.
      void this.pushCallCleared(session.recipientId, session.callId);
    }
  }

  // ── Push notifications (only reached when the recipient was presence-
  // offline at initiate() — see the isOnline branch above) ───────────────────

  private async pushIncomingCall(session: ActiveCallSession, callerUsername: string): Promise<void> {
    if (!isNotificationProviderEnabled("push")) return;
    const prefs = await new PushRepository(this.fastify.prisma).getPreferences(session.recipientId);
    if (prefs?.pushCalls === false) return;
    const payload: PushPayload = {
      v:     1,
      type:  "call_incoming",
      title: `Incoming ${session.type === "VIDEO" ? "video" : "audio"} call`,
      body:  `from @${callerUsername}`,
      url:   session.conversationId ? `/conversations/${session.conversationId}` : "/conversations",
      tag:   `call-${session.callId}`,
    };
    await pushQueue.add(SEND_PUSH_JOB, { userId: session.recipientId, payload });
  }

  private async pushMissedCall(recipientId: string, callId: string, callerUsername: string): Promise<void> {
    if (!isNotificationProviderEnabled("push")) return;
    const prefs = await new PushRepository(this.fastify.prisma).getPreferences(recipientId);
    if (prefs?.pushCalls === false) return;
    const payload: PushPayload = {
      v:     1,
      type:  "call_missed",
      title: "Missed call",
      body:  `from @${callerUsername}`,
      url:   "/calls",
      tag:   `call-${callId}`,
    };
    await pushQueue.add(SEND_PUSH_JOB, { userId: recipientId, payload });
  }

  private async pushCallCleared(recipientId: string, callId: string): Promise<void> {
    if (!isNotificationProviderEnabled("push")) return;
    // No title/body — sw.js recognizes this type and closes the matching-tag
    // notification instead of displaying anything.
    const payload: PushPayload = { v: 1, type: "call_cleared", title: "", body: "", tag: `call-${callId}` };
    await pushQueue.add(SEND_PUSH_JOB, { userId: recipientId, payload });
  }
}
