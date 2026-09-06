import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useInViewport } from "./use-in-viewport";

let lastCallback: IntersectionObserverCallback;
const disconnect = vi.fn();
const observe = vi.fn();

beforeEach(() => {
  disconnect.mockClear();
  observe.mockClear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        lastCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    },
  );
});

function Harness() {
  const { ref, visible } = useInViewport<HTMLDivElement>();
  return <div ref={ref} data-testid="target" data-visible={visible} />;
}

describe("useInViewport() — basic smoke test", () => {
  it("starts not visible, flips to visible once the element intersects, and disconnects the observer", () => {
    render(<Harness />);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("target")).toHaveAttribute("data-visible", "false");

    act(() => {
      lastCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(screen.getByTestId("target")).toHaveAttribute("data-visible", "true");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
