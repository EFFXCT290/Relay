export type EmbedProvider_Name = "twitter" | "instagram" | "tiktok" | "youtube" | "generic";

export type EmbedResult = {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  type: string | null;
  provider: EmbedProvider_Name;
};

export interface EmbedProvider {
  canHandle(url: string): boolean;
  fetch(url: string): Promise<EmbedResult | null>;
}
