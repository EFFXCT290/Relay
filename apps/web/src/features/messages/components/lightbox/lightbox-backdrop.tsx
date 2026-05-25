"use client";

type Props = { onClick: () => void };

export function LightboxBackdrop({ onClick }: Props) {
  return (
    <div
      className="absolute inset-0"
      style={{ background: "rgba(0,0,0,0.92)" }}
      onClick={onClick}
      aria-hidden
    />
  );
}
