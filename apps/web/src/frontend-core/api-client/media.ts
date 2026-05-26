import { getApiUrl } from "@/frontend-core/runtime-env";
import { ApiError } from "@/frontend-core/api";
import type { MediaUploadResponse, DeliveryMode } from "@relay/contracts";

export const mediaApi = {
  upload: async (
    file:         File | Blob,
    uploadId:     string,
    signal?:      AbortSignal,
    deliveryMode: DeliveryMode = "optimized",
  ): Promise<MediaUploadResponse> => {
    const formData = new FormData();
    formData.append("file", file);

    // Must NOT set Content-Type — let the browser set the multipart boundary.
    // uploadId sent as a header so the server can deduplicate retried uploads.
    // X-Delivery-Mode carries the composer's optimized/LSS choice (6B.12); the
    // server may still auto-promote to LSS (HEVC/DNG).
    const res = await fetch(`${getApiUrl()}/api/media/upload`, {
      method:      "POST",
      credentials: "include",
      headers:     { "X-Upload-Id": uploadId, "X-Delivery-Mode": deliveryMode },
      body:        formData,
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

  // Voice notes go through the same endpoint; the recorder's measured duration
  // rides along in a header (the server can't cheaply probe Opus length).
  uploadVoice: async (
    blob:       Blob,
    uploadId:   string,
    durationMs: number,
    signal?:    AbortSignal,
  ): Promise<MediaUploadResponse> => {
    const formData = new FormData();
    formData.append("file", blob, "voice.opus");

    const res = await fetch(`${getApiUrl()}/api/media/upload`, {
      method:      "POST",
      credentials: "include",
      headers:     { "X-Upload-Id": uploadId, "X-Audio-Duration-Ms": String(Math.round(durationMs)) },
      body:        formData,
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
