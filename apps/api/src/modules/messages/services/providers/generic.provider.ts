import type { EmbedProvider, EmbedResult } from "./types.js";
import { tryOpenGraph } from "./utils.js";

export class GenericProvider implements EmbedProvider {
  // Catch-all — handles Reddit, GitHub, Spotify, and any other site.
  canHandle(_url: string): boolean {
    return true;
  }

  async fetch(url: string): Promise<EmbedResult | null> {
    const result = await tryOpenGraph(url);
    if (!result) return null;
    return { ...result, provider: "generic" };
  }
}
