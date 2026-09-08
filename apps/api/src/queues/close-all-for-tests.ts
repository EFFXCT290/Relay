// Every queue module in this directory opens its own ioredis connection the
// instant it's imported (a module-level `new Queue(...)`) — regardless of
// whether anything ever calls `.add()`. A route/service test that pulls in
// message.routes.ts, media.routes.ts, cleanup.worker.ts, etc. can end up
// opening any subset of these transitively, and `node --test` never exits
// while one is left open.
//
// Rather than each test file hand-rolling a close list for whichever subset
// it happens to import (which drifts the instant a file's import graph
// changes — see the CI hang from message-disappear.routes.test.ts adding a
// cleanup.worker.ts import without adding cleanupQueue to its close list),
// every test file's `after()` should just call this once. Dynamic `import()`
// is idempotent (an already-loaded module returns its cached instance), so
// closing a queue a given file never actually opened is a harmless no-op
// import + close, not a new connection.
//
// waitUntilReady() before close() is load-bearing, not defensive filler: a
// BullMQ Queue's underlying RedisConnection.status starts 'initializing' and
// only flips to 'ready' once its handshake completes (including an INFO
// round-trip in getRedisVersionAndType() — see node_modules/bullmq's
// classes/redis-connection.js). Queue.close() branches on that status; while
// still 'initializing' it force-disconnects the raw ioredis client instead of
// gracefully quitting. That races the in-flight handshake's own promise
// (RedisConnection's constructor does `this.initializing.catch(err =>
// this.emit('error', err))`), which then rejects post-disconnect and emits
// 'error' on the Queue. Nothing in this codebase attaches an 'error' listener
// to these singletons, so Node throws it as an unhandled exception —
// asynchronously, after the closing test/hook has already "ended" from the
// test runner's point of view. This only bites a queue a file never actually
// used (e.g. pushQueue/cleanupQueue in a file that only imports mediaRoutes):
// a queue that's had real traffic has long since reached 'ready' by the time
// this runs. Confirmed by direct repro: importing then immediately closing
// an untouched queue reproduces the hang/uncaught-'error' on this exact
// BullMQ version; awaiting waitUntilReady() first eliminates it.
export async function closeAllQueueConnections(): Promise<void> {
  const [{ mediaQueue, videoQueue, voiceQueue }, { pushQueue }, { cleanupQueue }] = await Promise.all([
    import("./media.queue.js"),
    import("./push.queue.js"),
    import("./cleanup.queue.js"),
  ]);
  const queues = [mediaQueue, videoQueue, voiceQueue, pushQueue, cleanupQueue];
  await Promise.all(queues.map((q) => q.waitUntilReady()));
  await Promise.all(queues.map((q) => q.close()));
}
