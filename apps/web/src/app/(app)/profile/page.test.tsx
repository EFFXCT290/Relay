import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfilePage from "./page";

// ChatThreadPage's own component test (apps/web/src/app/(app)/conversations/[id]/page.test.tsx)
// establishes the pattern this follows: mock next/navigation with a STABLE
// router reference, route a fake api() by path, and drive the real component
// through React Testing Library.

const routerStub = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
}));

// cropToSquareWebp needs createImageBitmap + canvas, neither available in
// jsdom — not what this test is about, so pass the file through unchanged.
vi.mock("@/shared/utils/crop-image", () => ({
  cropToSquareWebp: vi.fn(async (file: File) => file),
}));

const { usersApiMock } = vi.hoisted(() => ({
  usersApiMock: {
    uploadAvatar: vi.fn(),
    deleteAvatar: vi.fn(),
  },
}));
vi.mock("@/frontend-core/api-client/users", () => ({
  usersApi: usersApiMock,
}));

let apiImpl: (path: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>;
vi.mock("@/frontend-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/frontend-core/api")>();
  return { ...actual, api: (path: string, opts?: { method?: string; body?: unknown }) => apiImpl(path, opts) };
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installDefaultApiImpl(overrides: { avatarUrl?: string | null } = {}) {
  apiImpl = async (path: string) => {
    if (path === "/api/auth/me") {
      return { userId: "me-1", username: "alice", avatarUrl: overrides.avatarUrl ?? null, createdAt: new Date().toISOString() };
    }
    if (path.startsWith("/api/conversations")) return { conversations: [] };
    if (path.startsWith("/api/notifications")) return { notifications: [] };
    throw new Error(`unexpected api() call: ${path}`);
  };
}

beforeEach(() => {
  usersApiMock.uploadAvatar.mockReset();
  usersApiMock.deleteAvatar.mockReset();
  // jsdom has no createObjectURL/revokeObjectURL implementation at all.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => "blob:mock-optimistic-preview");
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
  // ProfilePage also renders <PushToggle>, whose usePushSubscription() calls
  // window.matchMedia — jsdom doesn't implement it at all. Unrelated to what
  // this test covers; just needs to not throw.
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ matches: false, media: query }),
    configurable: true,
    writable: true,
  });
});

function makePngFile(name = "photo.png"): File {
  return new File(["fake-image-bytes"], name, { type: "image/png" });
}

describe("ProfilePage — avatar optimistic upload", () => {
  it("shows the optimistic preview immediately, before the upload resolves", async () => {
    installDefaultApiImpl({ avatarUrl: null });
    render(<ProfilePage />);
    await screen.findByLabelText("Change profile photo");

    const uploadGate = deferred<{ avatarUrl: string }>();
    usersApiMock.uploadAvatar.mockReturnValue(uploadGate.promise);

    const user = userEvent.setup();
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makePngFile());

    // Optimistic preview must be visible NOW — the upload hasn't resolved yet.
    const img = await screen.findByAltText("@alice");
    expect(img).toHaveAttribute("src", "blob:mock-optimistic-preview");
    expect(screen.getByText("uploading…")).toBeInTheDocument();

    await act(async () => {
      uploadGate.resolve({ avatarUrl: "https://signed.example/new-avatar.webp" });
      await uploadGate.promise;
    });

    await waitFor(() => expect(screen.queryByText("uploading…")).not.toBeInTheDocument());
    expect(screen.queryByText(/upload failed/i)).not.toBeInTheDocument();
  });

  it("reverts to the previous avatar (not a broken/stale optimistic state) when the upload actually fails", async () => {
    const originalAvatarUrl = "https://signed.example/original-avatar.webp";
    installDefaultApiImpl({ avatarUrl: originalAvatarUrl });
    render(<ProfilePage />);
    await screen.findByLabelText("Change profile photo");

    // Sanity: the originally-loaded avatar is showing before we touch anything.
    expect(await screen.findByAltText("@alice")).toHaveAttribute("src", originalAvatarUrl);

    const uploadGate = deferred<{ avatarUrl: string }>();
    usersApiMock.uploadAvatar.mockReturnValue(uploadGate.promise);

    const user = userEvent.setup();
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makePngFile());

    // Optimistic preview takes over first.
    await waitFor(() => expect(screen.getByAltText("@alice")).toHaveAttribute("src", "blob:mock-optimistic-preview"));

    await act(async () => {
      uploadGate.reject(new Error("upload rejected by server"));
      await uploadGate.promise.catch(() => {});
    });

    // Reverted: back to the ORIGINAL avatar, not left showing the failed
    // optimistic preview, and not broken/empty either.
    await waitFor(() => expect(screen.getByAltText("@alice")).toHaveAttribute("src", originalAvatarUrl));
    expect(screen.getByText(/upload failed|error/i)).toBeInTheDocument();
    expect((URL.revokeObjectURL as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("blob:mock-optimistic-preview");
  });
});

describe("ProfilePage — loading state", () => {
  it("shows skeleton lines for username/joined-date and the Threads/Captures stats before profile data loads", async () => {
    const meGate = deferred<{ userId: string; username: string; avatarUrl: string | null; createdAt: string }>();
    apiImpl = async (path: string) => {
      if (path === "/api/auth/me") return meGate.promise;
      if (path.startsWith("/api/conversations")) return { conversations: [] };
      if (path.startsWith("/api/notifications")) return { notifications: [] };
      throw new Error(`unexpected api() call: ${path}`);
    };

    render(<ProfilePage />);

    // Avatar's own pulse (h-24 w-24 rounded-full, untouched by this change) +
    // username line + joined-date line + 2 stat lines (Threads, Captures) = 5.
    // "Ephemeral" is a permanent "—" (Phase 2, not yet built) — never a pulse.
    await waitFor(() => expect(document.querySelectorAll(".animate-pulse").length).toBe(5));

    const pulses = Array.from(document.querySelectorAll(".animate-pulse"));
    const circles = pulses.filter((p) => p.className.includes("rounded-full"));
    expect(circles).toHaveLength(1); // just the avatar
    // Ephemeral's "—" is a permanent Phase-2 placeholder, unrelated to loading
    // — it must still show exactly once (not doubled by a stray dash from a
    // field that should now be skeletoned instead of falling back to "—").
    expect(screen.getByText("Phase 2")).toBeInTheDocument();
    expect(screen.getAllByText("—", { exact: true })).toHaveLength(1);

    await act(async () => {
      meGate.resolve({ userId: "me-1", username: "alice", avatarUrl: null, createdAt: new Date().toISOString() });
      await meGate.promise;
    });

    expect(await screen.findByText("@alice")).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });
});
