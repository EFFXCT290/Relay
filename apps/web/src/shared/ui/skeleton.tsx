import { cn } from "@/frontend-core/utils";

// Shared loading-placeholder primitive. Extracted from the ad-hoc
// `animate-pulse rounded[-full] bg-white/5` blocks duplicated across
// conversations/page.tsx, conversations/search/page.tsx, and
// conversations/new/page.tsx — same look, now one place to change it.

type SkeletonProps = {
  className?: string;
  style?: React.CSSProperties;
};

export function Skeleton({ className, style }: SkeletonProps) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded bg-white/5", className)} style={style} />;
}

export function SkeletonCircle({ size, className }: { size: number; className?: string }) {
  return (
    <Skeleton
      className={cn("shrink-0 rounded-full", className)}
      style={{ width: size, height: size }}
    />
  );
}

export function SkeletonLine({ className }: SkeletonProps) {
  return <Skeleton className={cn("h-3.5 w-24", className)} />;
}
