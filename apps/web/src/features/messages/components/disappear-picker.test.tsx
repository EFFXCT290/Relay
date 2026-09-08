import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { DisappearSend } from "@relay/contracts";
import { DisappearPicker } from "./disappear-picker";

// DisappearPicker is a controlled leaf (ChatComposer owns the value so it can
// reset it after send) — wrap it in a tiny stateful harness so interaction
// tests read naturally instead of manually re-rendering after every onChange.
function Controlled({ onChange }: { onChange?: (v: DisappearSend | null) => void }) {
  const [value, setValue] = useState<DisappearSend | null>(null);
  return (
    <DisappearPicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe("DisappearPicker", () => {
  it("starts closed and off — no panel, trigger not armed", () => {
    render(<Controlled />);
    expect(screen.queryByText("Disappearing message")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Set message to disappear")).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the panel on trigger click, showing Off/Views/Timer", () => {
    render(<Controlled />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    expect(screen.getByText("Disappearing message")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("Views")).toBeInTheDocument();
    expect(screen.getByText("Timer")).toBeInTheDocument();
  });

  it("selecting Views defaults to viewLimit 1 and arms the trigger", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    fireEvent.click(screen.getByText("Views"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "views", viewLimit: 1 });
    expect(screen.getByLabelText("Disappearing message settings (on)")).toHaveAttribute("aria-pressed", "true");
  });

  it("picking a specific view count (3) calls onChange with that exact value", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    fireEvent.click(screen.getByText("Views"));
    fireEvent.click(screen.getByText("3"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "views", viewLimit: 3 });
  });

  it("selecting Timer defaults to the 10s preset", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    fireEvent.click(screen.getByText("Timer"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "time", ttlSeconds: 10 });
  });

  it("picking the 1h preset calls onChange with ttlSeconds 3600", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    fireEvent.click(screen.getByText("Timer"));
    fireEvent.click(screen.getByText("1h"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "time", ttlSeconds: 3600 });
  });

  it("switching back to Off calls onChange with null and disarms the trigger", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    fireEvent.click(screen.getByText("Views"));
    fireEvent.click(screen.getByText("Off"));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByLabelText("Set message to disappear")).toHaveAttribute("aria-pressed", "false");
  });

  it("closes the panel on Escape", () => {
    render(<Controlled />);
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    expect(screen.getByText("Disappearing message")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Disappearing message")).not.toBeInTheDocument();
  });

  it("closes the panel on an outside click", () => {
    render(
      <div>
        <div data-testid="outside">elsewhere</div>
        <Controlled />
      </div>,
    );
    fireEvent.click(screen.getByLabelText("Set message to disappear"));
    expect(screen.getByText("Disappearing message")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("Disappearing message")).not.toBeInTheDocument();
  });
});
