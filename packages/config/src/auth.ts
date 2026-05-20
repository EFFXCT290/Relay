// Auth & security configuration constants shared across api and (where
// relevant) web/worker. Values here are policy, not secrets — secrets live
// in env vars per app.

export const ACCESS_TOKEN_TTL_SEC  = 15 * 60;        // 15 minutes
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days
export const BCRYPT_ROUNDS         = 12;
