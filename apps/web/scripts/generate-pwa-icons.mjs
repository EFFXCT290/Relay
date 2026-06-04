// Generates the PWA icon set from the Relay "signal-arc" brand mark
// (center dot + two concentric arcs — same mark as shared/components/wordmark.tsx).
// Rasterizes SVG → PNG with sharp at the sizes manifest.ts / layout.tsx reference.
//
// Run: node apps/web/scripts/generate-pwa-icons.mjs
// (sharp is resolved from apps/api/node_modules, where it's already a dependency.)
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const apiNodeModules = resolve(here, "../../api/node_modules/sharp/package.json");
const require = createRequire(apiNodeModules);
const sharp = require("sharp");

const OUT = resolve(here, "../public/icons");
const BG = "#0A0A0B";
const SIGNAL = "#3B82F6";

// The 22-unit mark, scaled/centered onto a `size` canvas. `inset` (0..1) shrinks
// the mark for maskable safe-zone padding. `bg` null → transparent (badge).
function markSvg({ size, inset = 1, bg = BG, color = SIGNAL, rounded = false }) {
  const span = size * 0.62 * inset;          // mark draws ~18 of its 22 units
  const s = span / 18;
  const tx = size / 2 - 11 * s;              // map mark center (11,11) → canvas center
  const radius = rounded ? size * 0.22 : 0;
  const bgRect = bg
    ? `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${bg}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bgRect}
  <g transform="translate(${tx} ${tx}) scale(${s})" fill="none" stroke-linecap="round">
    <circle cx="11" cy="11" r="2.2" fill="${color}"/>
    <path d="M5.5 11a5.5 5.5 0 0 1 11 0" stroke="${color}" stroke-width="1.4" opacity="0.55"/>
    <path d="M2 11a9 9 0 0 1 18 0" stroke="${color}" stroke-width="1.4" opacity="0.22"/>
  </g>
</svg>`;
}

async function png(svg, file) {
  const out = resolve(OUT, file);
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log("wrote", file);
}

await mkdir(OUT, { recursive: true });
await png(markSvg({ size: 192, rounded: true }), "icon-192.png");
await png(markSvg({ size: 512, rounded: true }), "icon-512.png");
// Maskable: fill the whole square (Android masks the shape) + safe-zone inset.
await png(markSvg({ size: 512, inset: 0.78, rounded: false }), "icon-512-maskable.png");
// Apple touch: opaque square, no transparency, no rounding (iOS rounds it).
await png(markSvg({ size: 180, rounded: false }), "apple-touch-icon-180.png");
// Android status-bar badge: monochrome white mark on transparent, 96×96.
await png(markSvg({ size: 96, bg: null, color: "#FFFFFF" }), "badge.png");
console.log("done");
