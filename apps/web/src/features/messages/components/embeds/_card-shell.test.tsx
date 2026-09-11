import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ImageBanner } from "./_card-shell";

// ImageBanner is the shared shell every embed type (generic, Twitter,
// Instagram, TikTok, YouTube) renders its thumbnail through — fixing its
// loading placeholder here fixes all of them at once.

describe("ImageBanner — loading placeholder", () => {
  it("shows a pulsing skeleton, with the image hidden (opacity 0), before it loads", () => {
    const { container } = render(<ImageBanner src="https://example.test/banner.jpg" alt="test" />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1);
    expect((container.querySelector("img") as HTMLImageElement).style.opacity).toBe("0");
  });

  it("removes the skeleton and fades the image in once it loads", () => {
    const { container } = render(<ImageBanner src="https://example.test/banner.jpg" alt="test" />);
    fireEvent.load(container.querySelector("img")!);

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect((container.querySelector("img") as HTMLImageElement).style.opacity).toBe("1");
  });

  it("removes the skeleton and hides the broken image on error, instead of leaving a permanent pulse", () => {
    const { container } = render(<ImageBanner src="https://example.test/banner.jpg" alt="test" />);
    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect((container.querySelector("img") as HTMLImageElement).style.display).toBe("none");
  });

  it("still renders a passed overlay (e.g. YouTube's play button) regardless of load state", () => {
    const { getByText } = render(
      <ImageBanner src="https://example.test/banner.jpg" alt="test" overlay={<span>▶</span>} />,
    );
    expect(getByText("▶")).toBeInTheDocument();
  });
});
