export type UploadedMedia = {
  mediaId:    string;
  storageKey: string;
  mimeType:   string;
  sizeBytes:  number;
  width:      number | null;
  height:     number | null;
  durationMs: number | null;   // voice notes only; null for images
  // Phase 6B — effective delivery mode (optional: voice never sets it).
  deliveryMode?: "optimized" | "lss";
  isLss?:        boolean;
};
