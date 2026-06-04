import type { MetadataRoute } from "next";

// PWA manifest (Next auto-serves at /manifest.webmanifest and links it in <head>).
// display:standalone + the icon set make Relay installable on macOS Safari and
// iOS "Add to Home Screen" — the prerequisite for Web Push on Apple devices.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Relay",
    short_name: "Relay",
    description: "A secure way to message.",
    start_url: "/conversations",
    display: "standalone",
    background_color: "#0A0A0B",
    theme_color: "#0A0A0B",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
