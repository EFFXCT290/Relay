import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ContactInfoModal } from "./contact-info-modal";

vi.mock("@/frontend-core/api-client/nicknames", () => ({
  nicknamesApi: {
    get: vi.fn(async () => ({ nickname: null, sharedWithTarget: false })),
    set: vi.fn(async (_userId: string, payload: { nickname: string; sharedWithTarget: boolean }) => payload),
    clear: vi.fn(async () => {}),
  },
}));

// SpotifyBadge does its own fetch on mount — stub the underlying API so it
// resolves to "nothing to show" instead of hitting a real network call.
vi.mock("@/frontend-core/api-client/spotify", () => ({
  spotifyApi: { getBadge: vi.fn(async () => ({ spotify: null })) },
}));

// Info Card's media count is fetched on mount — stub it so tests don't hit
// the network; individual tests override the resolved value as needed.
vi.mock("@/frontend-core/api-client/media", () => ({
  mediaApi: { gallery: vi.fn(async () => ({ items: [], nextCursor: null, totalCount: 0 })) },
}));

import { nicknamesApi } from "@/frontend-core/api-client/nicknames";
import { mediaApi } from "@/frontend-core/api-client/media";

const PARTICIPANT = { userId: "user-1", username: "alice" };
const CONVERSATION_CREATED_AT = "2026-05-01T00:00:00.000Z";

function renderModal(
  overrides: Partial<typeof PARTICIPANT & { nickname: string | null }> = {},
  callbacks: Partial<{
    onNicknameChange: (nickname: string | null) => void;
    onOpenMedia: () => void;
    onOpenPinned: () => void;
    onStartVoiceCall: () => void;
    onStartVideoCall: () => void;
    pinCount: number;
  }> = {},
) {
  const onClose = vi.fn();
  const onNicknameChange = callbacks.onNicknameChange ?? vi.fn();
  const onOpenMedia = callbacks.onOpenMedia ?? vi.fn();
  const onOpenPinned = callbacks.onOpenPinned ?? vi.fn();
  const onStartVoiceCall = callbacks.onStartVoiceCall ?? vi.fn();
  const onStartVideoCall = callbacks.onStartVideoCall ?? vi.fn();
  render(
    <ContactInfoModal
      participant={{ ...PARTICIPANT, ...overrides }}
      conversationId="conv-1"
      conversationCreatedAt={CONVERSATION_CREATED_AT}
      pinCount={callbacks.pinCount ?? 0}
      onClose={onClose}
      onNicknameChange={onNicknameChange}
      onOpenMedia={onOpenMedia}
      onOpenPinned={onOpenPinned}
      onStartVoiceCall={onStartVoiceCall}
      onStartVideoCall={onStartVideoCall}
    />,
  );
  return { onClose, onNicknameChange, onOpenMedia, onOpenPinned, onStartVoiceCall, onStartVideoCall };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nicknamesApi.get).mockResolvedValue({ nickname: null, sharedWithTarget: false });
  vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
});

describe("ContactInfoModal — stacking order and defaults", () => {
  it("always shows the real @username, regardless of nickname state", async () => {
    renderModal();
    expect(screen.getByText(/@alice\s+·/)).toBeInTheDocument();
  });

  it("no nickname set: shows 'Add nickname', no Share toggle (nothing to share yet)", async () => {
    renderModal();
    expect(screen.getByText("Add nickname")).toBeInTheDocument();
    expect(screen.queryByLabelText("Share nickname")).not.toBeInTheDocument();
  });

  it("nickname set: shows the plain nickname text (no @ prefix) instead of the 'Add nickname' trigger", async () => {
    renderModal({ nickname: "Bug" });
    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.queryByText("Add nickname")).not.toBeInTheDocument();
    // Real username is still shown alongside it, never hidden.
    expect(screen.getByText(/@alice\s+·/)).toBeInTheDocument();
  });

  it("nickname set: the Share toggle appears, reflecting the fetched sharedWithTarget value", async () => {
    vi.mocked(nicknamesApi.get).mockResolvedValue({ nickname: "Bug", sharedWithTarget: true });
    renderModal({ nickname: "Bug" });
    await waitFor(() => expect(screen.getByLabelText("Share nickname")).toHaveAttribute("aria-checked", "true"));
  });
});

describe("ContactInfoModal — editing", () => {
  it("clicking 'Add nickname' opens an inline editor with Save disabled until text is entered", async () => {
    renderModal();
    fireEvent.click(screen.getByText("Add nickname"));
    const input = screen.getByPlaceholderText("Nickname");
    expect(input).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeDisabled();

    fireEvent.change(input, { target: { value: "Bug" } });
    expect(screen.getByText("Save")).not.toBeDisabled();
  });

  it("Save calls nicknamesApi.set with the typed nickname and the current share state, then bubbles the new value up", async () => {
    const { onNicknameChange } = renderModal();
    fireEvent.click(screen.getByText("Add nickname"));
    fireEvent.change(screen.getByPlaceholderText("Nickname"), { target: { value: "Bug" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(nicknamesApi.set).toHaveBeenCalledWith("user-1", { nickname: "Bug", sharedWithTarget: false }),
    );
    await waitFor(() => expect(onNicknameChange).toHaveBeenCalledWith("Bug"));
  });

  it("clicking an existing nickname re-opens the editor pre-filled with the current value", async () => {
    renderModal({ nickname: "Bug" });
    fireEvent.click(screen.getByText("Bug"));
    expect(screen.getByPlaceholderText("Nickname")).toHaveValue("Bug");
  });

  it("Cancel discards the draft without calling the API", async () => {
    renderModal({ nickname: "Bug" });
    fireEvent.click(screen.getByText("Bug"));
    fireEvent.change(screen.getByPlaceholderText("Nickname"), { target: { value: "Something else" } });
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(nicknamesApi.set).not.toHaveBeenCalled();
  });
});

describe("ContactInfoModal — share toggle and removal", () => {
  it("toggling Share (with an already-saved nickname, not mid-edit) re-saves the SAME nickname with the new share state", async () => {
    vi.mocked(nicknamesApi.get).mockResolvedValue({ nickname: "Bug", sharedWithTarget: false });
    const { onNicknameChange } = renderModal({ nickname: "Bug" });
    await waitFor(() => expect(screen.getByLabelText("Share nickname")).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(screen.getByLabelText("Share nickname"));

    await waitFor(() =>
      expect(nicknamesApi.set).toHaveBeenCalledWith("user-1", { nickname: "Bug", sharedWithTarget: true }),
    );
    await waitFor(() => expect(onNicknameChange).toHaveBeenCalledWith("Bug"));
  });

  it("Remove nickname clears it via the API and reverts the view to the real username", async () => {
    vi.mocked(nicknamesApi.get).mockResolvedValue({ nickname: "Bug", sharedWithTarget: true });
    const { onNicknameChange } = renderModal({ nickname: "Bug" });
    await waitFor(() => screen.getByText("Remove nickname"));

    fireEvent.click(screen.getByText("Remove nickname"));

    await waitFor(() => expect(nicknamesApi.clear).toHaveBeenCalledWith("user-1"));
    await waitFor(() => expect(onNicknameChange).toHaveBeenCalledWith(null));
  });
});

describe("ContactInfoModal — actions row", () => {
  it("Voice and Video buttons call their respective callbacks", () => {
    const { onStartVoiceCall, onStartVideoCall } = renderModal();
    fireEvent.click(screen.getByText("Voice"));
    expect(onStartVoiceCall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Video"));
    expect(onStartVideoCall).toHaveBeenCalledTimes(1);
  });

  it("Search is a disabled, inert placeholder (no destination exists yet)", () => {
    renderModal();
    expect(screen.getByText("Search").closest("button")).toBeDisabled();
  });
});

describe("ContactInfoModal — info card (media + pinned)", () => {
  it("fetches and shows the real media count, and opens the shared-media grid on tap", async () => {
    vi.mocked(mediaApi.gallery).mockResolvedValue({ items: [], nextCursor: null, totalCount: 152 });
    const { onOpenMedia, onOpenPinned } = renderModal();

    await waitFor(() => expect(screen.getByText("152")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Media, links and docs"));
    expect(onOpenMedia).toHaveBeenCalledTimes(1);
    expect(onOpenPinned).not.toHaveBeenCalled();
  });

  it("shows the real pinned count (from the pinCount prop, not a re-fetch) and opens the existing PinnedMessagesList on tap — not a second list", async () => {
    const { onOpenPinned, onOpenMedia } = renderModal({}, { pinCount: 3 });
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Pinned messages"));
    expect(onOpenPinned).toHaveBeenCalledTimes(1);
    expect(onOpenMedia).not.toHaveBeenCalled();
  });

  it("shows a 'Chatting since' footer derived from conversationCreatedAt", () => {
    renderModal();
    expect(screen.getByText(/Chatting since/)).toBeInTheDocument();
  });
});

describe("ContactInfoModal — responsive shell (desktop modal vs mobile full page)", () => {
  it("is one component that switches via lg: classes — no scrim on mobile, scrim + fixed width + rounded panel at lg:", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    // Mobile-default: fills the viewport, no rounding/border.
    expect(dialog.className).toMatch(/flex-1/);
    // Desktop: fixed width, centered, rounded panel — gated behind lg:.
    expect(dialog.className).toMatch(/lg:w-\[420px\]/);
    expect(dialog.className).toMatch(/lg:rounded-\[20px\]/);
    // Scrim exists but is hidden until lg: (mobile is a full page, not an
    // overlay over the conversation behind it).
    const scrim = dialog.previousElementSibling as HTMLElement;
    expect(scrim.className).toMatch(/hidden/);
    expect(scrim.className).toMatch(/lg:block/);
  });
});

describe("ContactInfoModal — closing", () => {
  it("Escape calls onClose", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop calls onClose; clicking the panel itself does not", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
