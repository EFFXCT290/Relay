import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ACK_EVENT,
  ACK_BACKOFF_BASE,
  ACK_MAX_ATTEMPTS,
  ACK_TIMEOUT_MS,
  DEDUP_WINDOW,
  type Ack,
  type EventEnvelope,
} from "@relay/contracts";

// reliable.ts is documented as a load-bearing SIBLING of the server's
// apps/api/src/sockets/ack.ts — "these two files evolve as a SINGLE LOGICAL
// UNIT". They can't share code (different apps, different runtimes), so the
// only way to catch wire-format drift from THIS side is to drive the client
// against a faithful in-test mirror of ack.ts's actual algorithm, not just a
// bare stub that always says "ok". FakeAckServer below reproduces withAck's
// exact documented behavior (dedup cache keyed by eventId, capped at
// DEDUP_WINDOW entries, re-emits the CACHED Ack on a retry WITHOUT
// re-running the handler) — see apps/api/src/sockets/ack.ts's
// withAck/remember/recall for the real implementation this mirrors.

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  connected = true;
  private listeners = new Map<string, Set<Listener>>();
  emitLog: Array<{ event: string; payload: unknown }> = [];
  private dropNextAck = false;

  emit(event: string, payload?: unknown): void {
    this.emitLog.push({ event, payload });
    if (event === ACK_EVENT && this.dropNextAck) {
      this.dropNextAck = false;
      return; // simulates one lost/never-delivered ack packet
    }
    // Real Socket.IO delivery is NEVER synchronous with the emit() call that
    // triggered it (it's always a later network/event-loop turn) — deferring
    // here matters, not just for realism: emitReliable() calls
    // getSocket().emit(...) and THEN registers the pending entry those
    // listeners look up, so a same-tick synchronous callback would find no
    // pending entry yet and silently drop a same-tick ack.
    const listeners = [...(this.listeners.get(event) ?? [])];
    queueMicrotask(() => { for (const l of listeners) l(payload); });
  }
  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
  emitCallsFor(event: string) {
    return this.emitLog.filter((e) => e.event === event);
  }
  armDropNextAck(): void {
    this.dropNextAck = true;
  }
}

// Faithful mirror of apps/api/src/sockets/ack.ts's withAck — see file banner.
class FakeAckServer {
  private acked = new Map<string, Ack>();
  private order: string[] = [];
  handlerRuns = 0;
  receivedEnvelopes: EventEnvelope[] = [];

  constructor(
    private socket: FakeSocket,
    eventName: string,
    private decide: (env: EventEnvelope) => Ack,
  ) {
    socket.on(eventName, (envelope: unknown) => this.handle(envelope as EventEnvelope));
  }

  private handle(envelope: EventEnvelope): void {
    const cached = this.acked.get(envelope.eventId);
    if (cached) {
      this.socket.emit(ACK_EVENT, cached); // dedup — re-ack WITHOUT re-running the handler
      return;
    }
    this.handlerRuns++;
    this.receivedEnvelopes.push(envelope);
    const ack = this.decide(envelope);
    this.remember(envelope.eventId, ack);
    this.socket.emit(ACK_EVENT, ack);
  }

  private remember(eventId: string, ack: Ack): void {
    this.order.push(eventId);
    this.acked.set(eventId, ack);
    while (this.order.length > DEDUP_WINDOW) {
      const oldest = this.order.shift()!;
      this.acked.delete(oldest);
    }
  }
}

let fakeSocket: FakeSocket;

vi.mock("./socket", () => ({
  getSocket: () => fakeSocket,
  getReconnectEpoch: () => 0,
}));

// reliable.ts keeps module-level state (the `pending` map, `ackBound`) — a
// fresh dynamic import per test (after vi.resetModules()) mirrors the
// cache-busting pattern used for the same reason in apps/api's tests
// (e.g. presence.service.test.ts), so no test's retry timers or ack
// listeners leak into the next.
async function freshReliable() {
  vi.resetModules();
  fakeSocket = new FakeSocket();
  const mod = await import("./reliable");
  return { mod, socket: fakeSocket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("emitReliable() — wire format agreement with the server's ack.ts", () => {
  it("sends an EventEnvelope shaped exactly as ack.ts's withAck expects, and resolves on a real 'ok' ack from a faithful server mirror", async () => {
    const { mod, socket } = await freshReliable();
    const server = new FakeAckServer(socket, "message:new", (env) => ({ eventId: env.eventId, status: "ok" }));

    await mod.emitReliable("message:new", { body: "hi" });

    expect(server.handlerRuns).toBe(1);
    const env = server.receivedEnvelopes[0]!;
    expect(typeof env.eventId).toBe("string");
    expect(env.eventName).toBe("message:new");
    expect(env.payload).toEqual({ body: "hi" });
    expect(typeof env.timestamp).toBe("string");
    expect(env.attempts).toBe(1);
  });

  it("an 'error' ack rejects emitReliable with the server-provided message", async () => {
    const { mod, socket } = await freshReliable();
    new FakeAckServer(socket, "message:react", (env) => ({
      eventId: env.eventId,
      status: "error",
      error: { code: "forbidden", message: "not a participant" },
    }));

    await expect(mod.emitReliable("message:react", { emoji: "👍" })).rejects.toThrow("not a participant");
  });
});

describe("emitReliable() — retry timing (fake timers) and the dedup contract with a faithful ack.ts mirror", () => {
  it("retries with the SAME eventId after ACK_TIMEOUT_MS + backoff, and the server's dedup cache re-acks it without re-running the handler", async () => {
    vi.useFakeTimers();
    const { mod, socket } = await freshReliable();
    const server = new FakeAckServer(socket, "message:new", (env) => ({ eventId: env.eventId, status: "ok" }));

    socket.armDropNextAck(); // attempt 1's ack never reaches the client
    const promise = mod.emitReliable("message:new", { body: "retry me" });
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.emitCallsFor("message:new")).toHaveLength(1);
    expect(server.handlerRuns).toBe(1); // the handler DID run for attempt 1 — only the ack was lost

    // Must NOT retry before ACK_TIMEOUT_MS + ACK_BACKOFF_BASE*2^0 (5500ms).
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE - 1);
    expect(socket.emitCallsFor("message:new")).toHaveLength(1);

    // Crossing the threshold sends attempt 2 — this time the ack goes through.
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.emitCallsFor("message:new")).toHaveLength(2);

    await promise;

    // The critical wire-format invariant: attempt 2 must carry the EXACT
    // SAME eventId as attempt 1 (not a fresh one), which is what let the
    // server's dedup cache recognize it as a retry rather than a new send —
    // proven here by handlerRuns staying at 1 despite two deliveries.
    expect(server.handlerRuns).toBe(1);
    const [firstEnvelope, secondEnvelope] = socket.emitCallsFor("message:new").map((c) => c.payload as EventEnvelope);
    expect(secondEnvelope!.eventId).toBe(firstEnvelope!.eventId);
    expect(secondEnvelope!.attempts).toBe(2);
  });

  it("backoff grows between successive retries (attempt 2 waits longer than attempt 1), not a constant delay", async () => {
    vi.useFakeTimers();
    const { mod, socket } = await freshReliable();
    // Deliberately no server attached — nothing ever acks, so every
    // attempt's own timer runs to completion, isolating pure retry timing.

    const promise = mod.emitReliable("message:new", { body: "x" }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.emitCallsFor("message:new")).toHaveLength(1); // attempt 1

    // attempt 1 → attempt 2 threshold: ACK_TIMEOUT_MS + BASE*2^0
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE - 1);
    expect(socket.emitCallsFor("message:new")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.emitCallsFor("message:new")).toHaveLength(2); // attempt 2 fires right on schedule

    // attempt 2 → attempt 3 threshold: ACK_TIMEOUT_MS + BASE*2^1 — strictly
    // longer than the attempt 1→2 gap above (exponential, not constant).
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE * 2 - 1);
    expect(socket.emitCallsFor("message:new")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.emitCallsFor("message:new")).toHaveLength(3); // attempt 3 (the last one — ACK_MAX_ATTEMPTS)

    // Past attempt 3's own retry threshold, emitReliable gives up (no 4th
    // send) and rejects — advance far enough to observe that settle.
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE * 4);
    expect(socket.emitCallsFor("message:new")).toHaveLength(3);

    const result = await promise; // resolves to the rejection Error caught above, not thrown
    expect(result).toBeInstanceOf(Error);
  });

  it("gives up after ACK_MAX_ATTEMPTS with NO further send, rejecting with a clear message", async () => {
    expect(ACK_MAX_ATTEMPTS).toBe(3); // the test below is written assuming this exact value
    vi.useFakeTimers();
    const { mod, socket } = await freshReliable();
    // No server attached — nothing ever acks, for any of the 3 attempts.

    const promise = mod.emitReliable("message:new", { body: "never acked" });
    const assertion = expect(promise).rejects.toThrow(`No ACK for message:new after ${ACK_MAX_ATTEMPTS} attempts`);

    await vi.advanceTimersByTimeAsync(0); // attempt 1
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE); // attempt 2
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE * 2); // attempt 3
    expect(socket.emitCallsFor("message:new")).toHaveLength(3);

    // Past attempt 3's own retry threshold: must reject, NOT send a 4th attempt.
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + ACK_BACKOFF_BASE * 4);
    expect(socket.emitCallsFor("message:new")).toHaveLength(3);

    await assertion;
  });
});
