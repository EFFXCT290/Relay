// Persists upload batch state to localStorage so in-progress uploads can
// survive page refresh. Only the "sending" phase (all uploads done, POST
// not yet sent) can be fully auto-resumed — "uploading" sessions are kept
// so the user isn't surprised, but files are gone and can't be re-uploaded.

const STORAGE_KEY = "relay:upload_sessions";
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export type UploadSession = {
  sessionId:       string;
  conversationId:  string;
  fileCount:       number;
  clientUploadIds: string[];  // one per file — stable across retries
  mediaIds:        string[];  // populated progressively as uploads complete
  status:          "uploading" | "sending" | "completed";
  createdAt:       number;
};

function readAll(): UploadSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as UploadSession[];
  } catch {
    return [];
  }
}

function writeAll(sessions: UploadSession[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // localStorage full or unavailable — non-fatal
  }
}

export function saveSession(session: UploadSession): void {
  const all = readAll().filter((s) => s.sessionId !== session.sessionId);
  writeAll([...all, session]);
}

export function updateSession(sessionId: string, patch: Partial<UploadSession>): void {
  writeAll(readAll().map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s)));
}

export function removeSession(sessionId: string): void {
  writeAll(readAll().filter((s) => s.sessionId !== sessionId));
}

// Returns sessions that can be auto-resumed or shown as orphaned errors on mount.
// Also cleans up completed and expired sessions.
export function drainSessions(conversationId: string): {
  resumable:  UploadSession[];  // status==="sending" — have all mediaIds, just need POST
  orphaned:   UploadSession[];  // status==="uploading" — files are gone
} {
  const now = Date.now();
  const all = readAll();
  const relevant = all.filter(
    (s) => s.conversationId === conversationId && now - s.createdAt < SESSION_TTL_MS,
  );
  const expired = all.filter(
    (s) => s.conversationId !== conversationId || now - s.createdAt >= SESSION_TTL_MS,
  );
  // Prune expired + completed globally
  writeAll(expired.filter((s) => s.status !== "completed"));

  const resumable  = relevant.filter((s) => s.status === "sending");
  const orphaned   = relevant.filter((s) => s.status === "uploading");
  // Remove resumed/orphaned from storage (they'll be handled by caller)
  for (const s of [...resumable, ...orphaned]) removeSession(s.sessionId);
  return { resumable, orphaned };
}
