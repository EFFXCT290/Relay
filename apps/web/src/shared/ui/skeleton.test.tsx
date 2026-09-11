import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton, SkeletonCircle, SkeletonLine } from "./skeleton";

function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("Skeleton primitive", () => {
  it("renders a pulsing block and merges a custom className", () => {
    const { container } = render(<Skeleton className="h-2 w-2" />);
    const el = container.firstElementChild!;
    const cls = classes(el);
    expect(cls).toContain("animate-pulse");
    expect(cls).toContain("bg-white/5");
    expect(cls).toContain("h-2");
    expect(cls).toContain("w-2");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });

  it("SkeletonCircle renders a rounded-full block sized to the given size prop, replacing the base's rounded", () => {
    const { container } = render(<SkeletonCircle size={48} />);
    const el = container.firstElementChild! as HTMLElement;
    const cls = classes(el);
    expect(cls).toContain("rounded-full");
    expect(cls).not.toContain("rounded"); // conflicting radius utility, merged away
    expect(el.style.width).toBe("48px");
    expect(el.style.height).toBe("48px");
  });

  it("SkeletonCircle at a different size (e.g. the 44px used by search rows) sizes independently", () => {
    const { container } = render(<SkeletonCircle size={44} />);
    const el = container.firstElementChild! as HTMLElement;
    expect(el.style.width).toBe("44px");
    expect(el.style.height).toBe("44px");
  });

  it("SkeletonLine renders a line-shaped (non-circular) block with a default text-line size", () => {
    const { container } = render(<SkeletonLine />);
    const cls = classes(container.firstElementChild!);
    expect(cls).toContain("h-3.5");
    expect(cls).toContain("w-24");
    expect(cls).not.toContain("rounded-full");
  });

  it("SkeletonLine's className override replaces its default size (e.g. the shorter secondary line)", () => {
    const { container } = render(<SkeletonLine className="h-3 w-3/5" />);
    const cls = classes(container.firstElementChild!);
    expect(cls).toContain("h-3");
    expect(cls).toContain("w-3/5");
    expect(cls).not.toContain("h-3.5");
    expect(cls).not.toContain("w-24");
  });
});
