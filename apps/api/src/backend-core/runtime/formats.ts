// TypeBox uses its own FormatRegistry — Ajv format names like "uuid" or
// "date-time" must be registered explicitly or validation throws
// "Unknown format". Import this file once at boot, before any route loads.

import { FormatRegistry } from "@sinclair/typebox";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value) => typeof value === "string" && UUID_RE.test(value));
}

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set(
    "date-time",
    (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
  );
}

if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set(
    "email",
    (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  );
}
