// Centralized env access. Fails fast on missing required vars at boot.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  return parsed;
}

export const env = {
  NODE_ENV: optional("NODE_ENV", "development") as "development" | "production",
  PORT: int("PORT", 3001),
  HOST: optional("HOST", "localhost"),
  BASE_URL: optional("BASE_URL", "http://localhost:3001"),
  WEB_ORIGIN: optional("WEB_ORIGIN", "http://localhost:3000"),

  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: optional("REDIS_URL", "redis://localhost:6379"),

  JWT_SECRET: required("JWT_SECRET"),
  JWT_REFRESH_SECRET: required("JWT_REFRESH_SECRET"),
  JWT_ACCESS_EXPIRY: int("JWT_ACCESS_EXPIRY", 900),
  JWT_REFRESH_EXPIRY: int("JWT_REFRESH_EXPIRY", 604800),

  COOKIE_SECRET: required("COOKIE_SECRET"),
} as const;

export const isProd = env.NODE_ENV === "production";
