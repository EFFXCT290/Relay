import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UploadPreview } from "./upload-preview";

function previews(n: number) {
  return Array.from({ length: n }, (_, i) => ({ blobUrl: `blob:preview-${i}` }));
}

// Snapshot test — renderGrid() branches purely on previews.length (1, 2, 3,
// 4+), so one snapshot per branch is what's worth pinning down.
describe("UploadPreview — renderGrid() layout branching", () => {
  it.each([1, 2, 3, 4, 6])("renders the expected grid layout for %i preview(s)", (n) => {
    const { container } = render(<UploadPreview previews={previews(n)} status="uploading" />);
    expect(container.innerHTML).toMatchSnapshot();
  });
});
