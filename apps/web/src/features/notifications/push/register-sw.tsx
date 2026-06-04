"use client";

import { useEffect } from "react";
import { getApiUrl } from "@/frontend-core/runtime-env";

// Registers the push service worker on every page load (feature-detected). The
// API origin is threaded through as ?api=... so the SW's pushsubscriptionchange
// handler can reach the API. Mounted once in the root layout.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const url = `/sw.js?api=${encodeURIComponent(getApiUrl())}`;
    navigator.serviceWorker.register(url, { scope: "/" }).catch(() => {
      /* registration is best-effort; the subscribe UI surfaces real failures */
    });
  }, []);
  return null;
}
