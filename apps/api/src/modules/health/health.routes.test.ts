import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import healthRoutes from "./health.routes.js";
import type { FastifyInstance } from "fastify";

// The health check's whole job is to detect that Postgres/Redis are
// unreachable — the only way to exercise that without actually taking down
// the shared real Postgres/Redis every other parallel test file in this
// suite depends on (see server.ts's real prisma/redis plugins) is to fake
// the two calls the route makes at the interface level. Everything else in
// this suite prefers real infra (see e.g. message.routes.test.ts's header
// comment) — this is the one deliberate exception, and only for the two
// methods the route actually calls.
function buildTestApp(opts: { dbOk: boolean; redisOk: boolean }): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("prisma", {
    $queryRaw: async () => {
      if (!opts.dbOk) throw new Error("simulated database outage");
      return [{ "?column?": 1 }];
    },
  } as unknown as FastifyInstance["prisma"]);
  app.decorate("redis", {
    ping: async () => {
      if (!opts.redisOk) throw new Error("simulated redis outage");
      return "PONG";
    },
  } as unknown as FastifyInstance["redis"]);
  return app;
}

describe("GET /health", () => {
  it("returns 200 {status:\"ok\"} when both database and redis are reachable", async () => {
    const app = buildTestApp({ dbOk: true, redisOk: true });
    await app.register(healthRoutes);

    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { status: string; checks: Record<string, string> };
    assert.equal(body.status, "ok");
    assert.equal(body.checks.server, "ok");
    assert.equal(body.checks.database, "ok");
    assert.equal(body.checks.redis, "ok");

    await app.close();
  });

  it("returns 503 {status:\"degraded\"} when the database is unreachable", async () => {
    const app = buildTestApp({ dbOk: false, redisOk: true });
    await app.register(healthRoutes);

    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { status: string; checks: Record<string, string> };
    assert.equal(body.status, "degraded");
    assert.equal(body.checks.database, "fail");
    assert.equal(body.checks.redis, "ok");

    await app.close();
  });

  it("returns 503 {status:\"degraded\"} when redis is unreachable", async () => {
    const app = buildTestApp({ dbOk: true, redisOk: false });
    await app.register(healthRoutes);

    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { status: string; checks: Record<string, string> };
    assert.equal(body.status, "degraded");
    assert.equal(body.checks.database, "ok");
    assert.equal(body.checks.redis, "fail");

    await app.close();
  });

  it("returns 503 {status:\"degraded\"} when both database and redis are unreachable", async () => {
    const app = buildTestApp({ dbOk: false, redisOk: false });
    await app.register(healthRoutes);

    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { status: string; checks: Record<string, string> };
    assert.equal(body.status, "degraded");
    assert.equal(body.checks.database, "fail");
    assert.equal(body.checks.redis, "fail");

    await app.close();
  });
});
