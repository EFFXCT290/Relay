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
export async function closeAllQueueConnections(): Promise<void> {
  const [{ mediaQueue, videoQueue, voiceQueue }, { pushQueue }, { cleanupQueue }] = await Promise.all([
    import("./media.queue.js"),
    import("./push.queue.js"),
    import("./cleanup.queue.js"),
  ]);
  await Promise.all([
    mediaQueue.close(),
    videoQueue.close(),
    voiceQueue.close(),
    pushQueue.close(),
    cleanupQueue.close(),
  ]);
}
