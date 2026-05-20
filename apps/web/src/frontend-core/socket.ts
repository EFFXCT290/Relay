"use client";

import { io, type Socket } from "socket.io-client";
import { getWsUrl } from "./runtime-env";

let socket: Socket | null = null;

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
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
