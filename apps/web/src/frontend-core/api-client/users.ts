import { getApiUrl } from "@/frontend-core/runtime-env";
import { api, ApiError } from "@/frontend-core/api";
import type { AvatarResponse } from "@relay/contracts";

export const usersApi = {
  // Multipart — must NOT set Content-Type so the browser sets the boundary.
  // The blob is already a cropped, downscaled webp (see cropToSquareWebp); the
  // server re-normalizes to 256×256 as a backstop.
  uploadAvatar: async (file: Blob, signal?: AbortSignal): Promise<AvatarResponse> => {
    const formData = new FormData();
    formData.append("file", file, "avatar.webp");

    const res = await fetch(`${getApiUrl()}/api/users/me/avatar`, {
      method:      "POST",
      credentials: "include",
      body:        formData,
      ...(signal ? { signal } : {}),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({
        type: "", title: "Upload failed", status: res.status, detail: res.statusText,
      }));
      throw new ApiError(data);
    }
    return res.json() as Promise<AvatarResponse>;
  },

  deleteAvatar: () => api<AvatarResponse>("/api/users/me/avatar", { method: "DELETE" }),
};
