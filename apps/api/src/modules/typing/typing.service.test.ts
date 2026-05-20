import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  TYPING_EVENTS,
  TYPING_TIMEOUT_MS,
  TYPING_SWEEP_INTERVAL_MS,
} from "@relay/contracts";

// We're testing module-singleton state, so re-import fresh each test by
// resetting the module cache. Easier than threading DI through the service
// for now — the service is intentionally simple.
async function freshService() {
  const url = new URL("./typing.service.ts", import.meta.url).href + `?t=${Math.random()}`;
  return import(url);
}

type EmittedEvent = { conversationId: string; userId: string; isTyping: boolean };

function makeFastify() {
  const emitted: { room: string; event: string; payload: EmittedEvent }[] = [];
  let lastRoom = "";
  const io = {
    to(room: string) {
      lastRoom = room;
      return {
        emit(event: string, payload: EmittedEvent) {
          emitted.push({ room: lastRoom, event, payload });
        },
      };
    },
  };
  const hooks: Array<() => Promise<void> | void> = [];
  const fastify = {
    io,
    addHook(_name: string, fn: () => Promise<void> | void) {
      hooks.push(fn);
    },
    // Test helper — invoke onClose hooks (simulates shutdown).
    async _close() {
      for (const fn of hooks) await fn();
    },
    _emitted: emitted,
  };
  return fastify as unknown as import("fastify").FastifyInstance & {
    _emitted: typeof emitted;
    _close: () => Promise<void>;
  };
}

describe("typing.service", () => {
  beforeEach(() => {
    mock.timers.reset();
  });

  it("broadcasts typing:update{isTyping:true} on first start, suppresses repeats while active", async () => {
    mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
    const svc = await freshService();
    const fastify = makeFastify();
    svc.startTypingSweep(fastify);

    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");

    assert.equal(fastify._emitted.length, 1);
    assert.deepEqual(fastify._emitted[0], {
      room: "conversation:conv-1",
      event: TYPING_EVENTS.UPDATE,
      payload: { conversationId: "conv-1", userId: "user-a", isTyping: true },
    });

    await fastify._close();
  });

  it("broadcasts typing:update{isTyping:false} on stop only if previously active", async () => {
    mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
    const svc = await freshService();
    const fastify = makeFastify();
    svc.startTypingSweep(fastify);

    // Stop with no active state — no broadcast.
    svc.typingStop(fastify, "conv-1", "user-a");
    assert.equal(fastify._emitted.length, 0);

    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    svc.typingStop(fastify, "conv-1", "user-a");
    svc.typingStop(fastify, "conv-1", "user-a"); // second stop is a no-op

    assert.equal(fastify._emitted.length, 2);
    assert.equal(fastify._emitted[0]!.payload.isTyping, true);
    assert.equal(fastify._emitted[1]!.payload.isTyping, false);

    await fastify._close();
  });

  it("sweep expires stale entries and broadcasts isTyping:false", async () => {
    mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
    const svc = await freshService();
    const fastify = makeFastify();
    svc.startTypingSweep(fastify);

    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    // Just past TYPING_TIMEOUT_MS — should expire on the next sweep tick.
    mock.timers.tick(TYPING_TIMEOUT_MS + 1);
    // Push to the next sweep boundary.
    mock.timers.tick(TYPING_SWEEP_INTERVAL_MS);

    const stopEvent = fastify._emitted.find((e) => e.payload.isTyping === false);
    assert.ok(stopEvent, "expected a typing:update{isTyping:false} from sweep");
    assert.equal(stopEvent!.payload.userId, "user-a");
    assert.equal(stopEvent!.payload.conversationId, "conv-1");

    await fastify._close();
  });

  it("a steady typer past the timeout stays active when refreshed within the window", async () => {
    mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
    const svc = await freshService();
    const fastify = makeFastify();
    svc.startTypingSweep(fastify);

    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    // Refresh just before timeout — should NOT broadcast again, should reset expiresAt.
    mock.timers.tick(TYPING_TIMEOUT_MS - 500);
    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    // Now run a sweep at the original expiry point + a bit — should NOT fire stop.
    mock.timers.tick(600); // total elapsed ≈ TYPING_TIMEOUT_MS + 100 from original start
    mock.timers.tick(TYPING_SWEEP_INTERVAL_MS);

    const stopEvent = fastify._emitted.find((e) => e.payload.isTyping === false);
    assert.equal(stopEvent, undefined, "refresh should have extended expiresAt past this sweep");
    assert.equal(fastify._emitted.length, 1, "only the initial start should have broadcast");

    await fastify._close();
  });

  it("typingClearForSocket clears every conversation the socket was typing in", async () => {
    mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
    const svc = await freshService();
    const fastify = makeFastify();
    svc.startTypingSweep(fastify);

    svc.typingStart(fastify, "conv-1", "user-a", "sock-a");
    svc.typingStart(fastify, "conv-2", "user-a", "sock-a");
    svc.typingStart(fastify, "conv-1", "user-b", "sock-b"); // different socket, should NOT be cleared

    svc.typingClearForSocket(fastify, "sock-a");

    const stops = fastify._emitted.filter((e) => e.payload.isTyping === false);
    assert.equal(stops.length, 2);
    const stoppedKeys = stops.map((e) => `${e.payload.conversationId}:${e.payload.userId}`).sort();
    assert.deepEqual(stoppedKeys, ["conv-1:user-a", "conv-2:user-a"]);

    // user-b on sock-b should still be active.
    const bEvents = fastify._emitted.filter((e) => e.payload.userId === "user-b");
    assert.equal(bEvents.length, 1);
    assert.equal(bEvents[0]!.payload.isTyping, true);

    await fastify._close();
  });
});
