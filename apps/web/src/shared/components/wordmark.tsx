import { cn } from "@/frontend-core/utils";

type Props = {
  className?: string;
  size?: number;
  showText?: boolean;
};

// Signal-arc mark — a center dot ("the message") wrapped by two
// concentric arcs ("the relay"). Used everywhere the brand appears.
export function Wordmark({ className, size = 22, showText = true }: Props) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 22 22"
        fill="none"
        className="shrink-0"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="2.2" fill="var(--color-signal)" />
        <path
          d="M5.5 11a5.5 5.5 0 0 1 11 0"
          stroke="var(--color-signal)"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.55"
        />
        <path
          d="M2 11a9 9 0 0 1 18 0"
          stroke="var(--color-signal)"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.22"
        />
      </svg>
      {showText && (
        <span
          className="text-[18px] font-extrabold tracking-[-0.02em] text-[var(--color-text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Relay
        </span>
      )}
    </div>
  );
}
