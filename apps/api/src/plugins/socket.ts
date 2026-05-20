import fp from "fastify-plugin";
import { Server as IOServer } from "socket.io";
import { ACCESS_COOKIE } from "../backend-core/auth/cookies.js";
import { env } from "../backend-core/runtime/env.js";
import { isBlocklisted, verifyAccessToken } from "../backend-core/auth/tokens.js";
import { registerAllSocketHandlers } from "../sockets/index.js";
import { MessageService } from "../modules/messages/message.service.js";
import { startTypingSweep } from "../modules/typing/typing.service.js";

declare module "socket.io" {
  interface Socket {
    userId: string;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket plugin. Two responsibilities, nothing else:
//   1. Authenticate the upgrade via the access cookie (same JWT as HTTP).
//   2. On each new connection, join the personal user room and hand the
//      socket to registerAllSocketHandlers — every per-event handler lives
//      in modules/<domain>/<domain>.socket.ts.
//
// Any per-domain logic (typing, conversation join/leave, delivered sweep,
// presence) lives in its module. Adding new realtime work? Touch a module
// file, not this one.
// ─────────────────────────────────────────────────────────────────────────────

export default fp(async (fastify) => {
  const io = new IOServer(fastify.server, {
    cors: {
      origin: env.WEB_ORIGIN,
      credentials: true,
    },
    transports: ["websocket", "polling"],
    serveClient: false,
  });

  // Cookie-based auth — same access token the HTTP API uses. We borrow
  // @fastify/cookie's parser via fastify.parseCookie so signing/unsigning
  // stays consistent with the HTTP path.
  io.use(async (socket, next) => {
    try {
      const rawCookie = socket.request.headers.cookie ?? "";
      const cookies = fastify.parseCookie(rawCookie);
      const token = cookies[ACCESS_COOKIE];
      if (!token) return next(new Error("unauthorized"));

      const payload = verifyAccessToken(token);
      if (await isBlocklisted(fastify.redis, payload.jti)) {
        return next(new Error("unauthorized"));
      }

      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.userId}`);

    // On reconnect, mark any messages addressed to this user as delivered
    // and notify each sender. Lives in MessageService — see SAFEGUARD 8.
    void new MessageService(fastify)
      .sweepUndelivered(socket.userId)
      .catch((err) => fastify.log.error({ err }, "delivered-sweep failed"));

    registerAllSocketHandlers(socket, fastify, socket.userId);
  });

  fastify.decorate("io", io);

  // Typing sweep timer + onClose teardown must register during plugin load —
  // Fastify forbids addHook once the instance is listening, so we can't do
  // this lazily on first socket connection.
  startTypingSweep(fastify);

  fastify.addHook("onClose", async () => {
    await io.close();
  });
});
