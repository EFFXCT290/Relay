import { cn } from "@/frontend-core/utils";

// Deterministic gradient per username — same input always renders the same
// pair of colors, so an avatar's identity is stable across the app.
const PALETTES: Array<[string, string]> = [
  ["#3B82F6", "#1E3A8A"], // signal blue
  ["#8B5CF6", "#4C1D95"], // violet
  ["#F59E0B", "#92400E"], // amber
  ["#06B6D4", "#155E75"], // cyan
  ["#EC4899", "#831843"], // pink
  ["#14B8A6", "#134E4A"], // teal
  ["#EF4444", "#7F1D1D"], // red
  ["#22C55E", "#14532D"], // green
];

function pickPalette(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PALETTES[Math.abs(hash) % PALETTES.length]!;
}

type Props = {
  username: string;
  size?: number;
  isOnline?: boolean;
  hasAlert?: boolean;
  className?: string;
};

export function Avatar({ username, size = 48, isOnline, hasAlert, className }: Props) {
  const initial = (username[0] ?? "?").toUpperCase();
  const [from, to] = pickPalette(username);
  const dotSize = Math.max(10, Math.round(size * 0.28));
  const fontSize = Math.round(size * 0.36);

  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded-full"
        style={{ background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` }}
      >
        <span
          className="font-bold text-white"
          style={{ fontFamily: "var(--font-display)", fontSize, letterSpacing: "-0.02em" }}
        >
          {initial}
        </span>
      </div>
      {isOnline && (
        <span
          className="absolute right-0 bottom-0 rounded-full border-[2.5px] border-[var(--color-bg)]"
          style={{
            width: dotSize,
            height: dotSize,
            background: "var(--color-online)",
            boxShadow: "0 0 6px rgba(34,197,94,0.6)",
          }}
        />
      )}
      {hasAlert && (
        <span
          className="absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full border-[2.5px] border-[var(--color-bg)]"
          style={{
            width: dotSize + 4,
            height: dotSize + 4,
            background: "var(--color-alert)",
            boxShadow: "0 0 8px rgba(239,68,68,0.6)",
          }}
        >
          <span className="block h-[3px] w-[2px] rounded-full bg-white" />
        </span>
      )}
    </div>
  );
}
