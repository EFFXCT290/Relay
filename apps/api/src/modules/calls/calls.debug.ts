import type { FastifyBaseLogger } from "fastify";

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in call-lifecycle tracing. Silent unless CALL_DEBUG=true, so it costs
// nothing in normal operation and can be flipped on to diagnose a "randomly
// broke" call without touching code.
//
// Scope is deliberate: it traces the things that matter for reasoning about a
// call's lifecycle — state transitions, terminate, and the offer/answer
// handshake. It does NOT trace ICE candidates: those fire dozens of times per
// call and would bury the signal. ICE problems show up as a connection-state
// transition, which IS traced.
// ─────────────────────────────────────────────────────────────────────────────

export const CALL_DEBUG = process.env.CALL_DEBUG === "true";

export function callDebug(
  log: FastifyBaseLogger,
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!CALL_DEBUG) return;
  log.info({ call: true, ...data }, `call: ${event}`);
}
