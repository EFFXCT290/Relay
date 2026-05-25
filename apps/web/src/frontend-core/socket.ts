"use client";

import { io, type Socket } from "socket.io-client";
import { getWsUrl } from "./runtime-env";

let socket: Socket | null = null;

// Incremented on every socket `connect` event (initial connect + every
// reconnect). Consumers capture the epoch at the start of an async reconnect
// flow and discard results if it has advanced past them by the time they land.
let reconnectEpoch = 0;
export function getReconnectEpoch(): number { return reconnectEpoch; }

// True singleton — return the existing instance regardless of `.connected`.
// Socket.IO queues emits while a connection is in flight, so the prior
// "only return when connected" check was actually a bug: it spawned a *second*
// socket whenever a component called getSocket() mid-handshake, and listeners
// registered against either instance would silently miss server events
// routed to the other one. The receiver in a chat would have to reload to
// observe live message:new events because of this race.
export function getSocket(): Socket {
  if (socket) return socket;
  socket = io(getWsUrl(), {
    withCredentials: true,
    transports: ["websocket", "polling"],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });
  socket.on("connect", () => { reconnectEpoch++; });
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
