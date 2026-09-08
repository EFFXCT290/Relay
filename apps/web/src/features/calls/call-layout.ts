import type { ScreenShareSharedBy } from "./call-store";

// ─────────────────────────────────────────────────────────────────────────────
// Pure layout decision for the connected-video call surface once screen share
// exists. Exported standalone (not inlined in call-ui.tsx) so the rendering
// rule — whose screen is full-width, whose camera(s) show and where — is
// unit-testable across the full sharedBy × showBothCameras matrix without a
// DOM, same rationale as summarizeStats() in webrtc.ts.
//
// The rule (see project-screen-share-plan memory):
//   nobody sharing        → unchanged existing camera-only layout
//   someone sharing       → their screen fills the stage; the LOCAL viewer's
//                            own camera self-preview is hidden regardless of
//                            who's sharing; the OTHER participant's camera
//                            shows as a small corner PiP by default
//   + showBothCameras     → (local-only preference, default off, never synced)
//                            reveals BOTH cameras in a column alongside a
//                            narrower share area, instead of just the corner PiP
// ─────────────────────────────────────────────────────────────────────────────

export type CallLayout =
  | { mode: "camera-only" }
  | {
      mode: "screen-share";
      // Whose screen fills the main stage.
      screenSource: "local" | "remote";
      // "corner-pip": only the other participant's camera, small corner PiP —
      // this viewer's own camera stays hidden.
      // "both-column": both cameras shown in a column next to a narrower share.
      cameraLayout: "corner-pip" | "both-column";
    };

export function computeCallLayout(sharedBy: ScreenShareSharedBy, showBothCameras: boolean): CallLayout {
  if (sharedBy === null) return { mode: "camera-only" };
  return {
    mode: "screen-share",
    screenSource: sharedBy,
    cameraLayout: showBothCameras ? "both-column" : "corner-pip",
  };
}
