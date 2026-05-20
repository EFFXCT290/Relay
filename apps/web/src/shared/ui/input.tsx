import * as React from "react";
import { cn } from "@/frontend-core/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-12 w-full rounded-[14px] bg-[var(--color-panel)] px-4 text-[16px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none transition-shadow",
          "border focus:border-[var(--color-signal)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.10)]",
          invalid
            ? "border-[var(--color-alert)] focus:border-[var(--color-alert)] focus:shadow-[0_0_0_3px_rgba(239,68,68,0.18)]"
            : "border-white/[0.07]",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
