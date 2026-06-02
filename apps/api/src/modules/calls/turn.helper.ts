import { createHmac } from "node:crypto";
import type { IceServer } from "@relay/contracts";
import { env } from "../../backend-core/runtime/env.js";

// ─────────────────────────────────────────────────────────────────────────────
// TURN credential minting (coturn TURN REST API / `static-auth-secret`).
//
// coturn validates time-limited credentials without any per-user account: the
// username is `<unix-expiry>:<userId>` and the password is the base64 HMAC-SHA1
// of that username keyed by the shared secret. So we mint fresh credentials per
// call here instead of provisioning TURN logins. The userId half is only there
// for traceability in coturn logs — coturn checks the HMAC, not the identity.
//
// generateTurnCredentials returns the full ICE server list to hand the browser:
// a public STUN server plus the TURN relay (UDP/TCP on 3478, TLS on 5349). With
// TURN unconfigured it degrades to STUN-only — see env.ts TURN_URL/TURN_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

// Generous so a long call or a mid-call ICE restart never re-gathers against an
// expired credential. The credential only gates *new* TURN allocations, so a
// wide window costs nothing — an exposed credential still dies within the day.
const TURN_CRED_TTL_SECONDS = 24 * 60 * 60;

// Public fallback — always present so calls still attempt a direct/STUN path
// even when no TURN relay is configured. Matches the old client-side default.
const STUN_SERVER: IceServer = { urls: "stun:stun.l.google.com:19302" };

// Accept a bare host ("turn.example.com") or a fully-qualified URL
// ("turns://turn.example.com:5349") and return just the host. Trailing port /
// path / query are dropped — we build the canonical coturn URL set ourselves.
function turnHost(raw: string): string {
  return raw
    .trim()
    .replace(/^(stun|turn|turns):\/\//i, "")
    .replace(/^(stun|turn|turns):/i, "")
    .replace(/[:/?].*$/, "")
    .trim();
}

export type TurnCredentials = {
  username:   string;
  credential: string;
  iceServers: IceServer[];
};

export function generateTurnCredentials(userId: string): TurnCredentials {
  const host = turnHost(env.TURN_URL);

  // Not configured → STUN-only. No username/credential to hand out.
  if (!host || !env.TURN_SECRET) {
    return { username: "", credential: "", iceServers: [STUN_SERVER] };
  }

  const expiry     = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_SECONDS;
  const username   = `${expiry}:${userId}`;
  const credential = createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");

  const turn: IceServer = {
    urls: [
      `turn:${host}:3478?transport=udp`,
      `turn:${host}:3478?transport=tcp`,
      `turns:${host}:5349?transport=tcp`,
    ],
    username,
    credential,
  };

  return { username, credential, iceServers: [STUN_SERVER, turn] };
}
