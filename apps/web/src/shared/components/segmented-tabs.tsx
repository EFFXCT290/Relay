import Link from "next/link";
import { cn } from "@/frontend-core/utils";

type Tab = { label: string; href: string };

type Props = {
  tabs: [Tab, Tab];
  active: 0 | 1;
};

// Two-option segmented control. The inactive option is a Link to the other
// route — keeps both states server-rendered so there's no flash on switch.
export function SegmentedTabs({ tabs, active }: Props) {
  return (
    <div
      className="flex items-center gap-1 rounded-[14px] border bg-[var(--color-panel)] p-1"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      {tabs.map((tab, i) => {
        const isActive = i === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex flex-1 items-center justify-center rounded-[10px] px-4 py-2.5 text-sm transition-colors",
              isActive
                ? "bg-[var(--color-raised)] font-semibold text-[var(--color-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),_0_0_0_1px_rgba(255,255,255,0.06)]"
                : "font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
