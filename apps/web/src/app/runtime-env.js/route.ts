// Serves window.__ENV__ as JS at request time, read from the running
// container's env. A synchronous <script src="/runtime-env.js"> in the root
// layout's <head> guarantees the global is set before any client bundle runs.

export const dynamic = "force-dynamic";

export function GET() {
  const env = {
    API_URL: process.env.API_URL ?? "",
    WS_URL: process.env.WS_URL ?? "",
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
  };
  return new Response(`window.__ENV__ = ${JSON.stringify(env)};`, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
