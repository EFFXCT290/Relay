import { api } from "@/frontend-core/api";
import type { NicknameInfo, SetNicknamePayload } from "@relay/contracts";

export const nicknamesApi = {
  get: (userId: string) => api<NicknameInfo>(`/api/users/${userId}/nickname`),
  set: (userId: string, payload: SetNicknamePayload) =>
    api<NicknameInfo>(`/api/users/${userId}/nickname`, { method: "PUT", body: payload }),
  clear: (userId: string) => api<void>(`/api/users/${userId}/nickname`, { method: "DELETE" }),
};
