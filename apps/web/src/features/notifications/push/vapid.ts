// Converts a base64url VAPID public key into the Uint8Array that
// PushManager.subscribe expects as its applicationServerKey. Single home for
// this helper so the hook (and any future caller) don't reimplement it.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Build on an explicit ArrayBuffer so the result is Uint8Array<ArrayBuffer>,
  // which PushManager.subscribe's applicationServerKey (BufferSource) accepts —
  // a bare `new Uint8Array(len)` infers ArrayBufferLike and is rejected.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
