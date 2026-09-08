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

import { nicknamesApi } from "@/frontend-core/api-client/nicknames";

const PARTICIPANT = { userId: "user-1", username: "alice" };

function renderModal(overrides: Partial<typeof PARTICIPANT & { nickname: string | null }> = {}, onNicknameChange = vi.fn()) {
  const onClose = vi.fn();
  render(
    <ContactInfoModal
      participant={{ ...PARTICIPANT, ...overrides }}
      onClose={onClose}
      onNicknameChange={onNicknameChange}
    />,
  );
  return { onClose, onNicknameChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nicknamesApi.get).mockResolvedValue({ nickname: null, sharedWithTarget: false });
});

describe("ContactInfoModal — stacking order and defaults", () => {
  it("always shows the real @username, regardless of nickname state", async () => {
    renderModal();
    expect(screen.getByText("@alice")).toBeInTheDocument();
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
    expect(screen.getByText("@alice")).toBeInTheDocument();
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
