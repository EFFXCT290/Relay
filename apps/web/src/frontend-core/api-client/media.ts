import { getApiUrl } from "@/frontend-core/runtime-env";
import { ApiError } from "@/frontend-core/api";
import type { MediaUploadResponse } from "@relay/contracts";

export const mediaApi = {
  upload: async (file: File | Blob, signal?: AbortSignal): Promise<MediaUploadResponse> => {
    const formData = new FormData();
    formData.append("file", file);

    // Must NOT set Content-Type — let the browser set the multipart boundary.
    const res = await fetch(`${getApiUrl()}/api/media/upload`, {
      method: "POST",
      credentials: "include",
      body: formData,
      signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({
        type: "", title: "Upload failed", status: res.status, detail: res.statusText,
      }));
      throw new ApiError(data);
    }

    return res.json() as Promise<MediaUploadResponse>;
  },
};
