export type UploadedMedia = {
  mediaId:    string;
  storageKey: string;
  mimeType:   string;
  sizeBytes:  number;
  width:      number | null;
  height:     number | null;
};
