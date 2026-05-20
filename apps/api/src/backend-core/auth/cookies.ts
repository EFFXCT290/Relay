import type { CookieSerializeOptions } from "@fastify/cookie";
import { env, isProd } from "../runtime/env.js";

const baseCookie: CookieSerializeOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: isProd,
  signed: false,
};

export const ACCESS_COOKIE = "accessToken";
export const REFRESH_COOKIE = "refreshToken";

// Scope to "/" so the Socket.IO handshake at /socket.io/* also receives the
// access token — without this the socket auth middleware never sees the
// cookie and rejects every connection, killing live messages/typing/read.
export const accessCookieOpts: CookieSerializeOptions = {
  ...baseCookie,
  path: "/",
  maxAge: env.JWT_ACCESS_EXPIRY,
};

export const refreshCookieOpts: CookieSerializeOptions = {
  ...baseCookie,
  path: "/api/auth",
  maxAge: env.JWT_REFRESH_EXPIRY,
};

// Use the same path on clear or the browser won't actually delete the cookie.
export const clearAccessCookieOpts: CookieSerializeOptions = {
  ...baseCookie,
  path: "/",
  maxAge: 0,
};

export const clearRefreshCookieOpts: CookieSerializeOptions = {
  ...baseCookie,
  path: "/api/auth",
  maxAge: 0,
};
