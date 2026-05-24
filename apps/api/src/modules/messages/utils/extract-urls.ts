export function extractUrls(text: string): string[] {
  const regex = /(https?:\/\/[^\s]+)/g;
  return text.match(regex) ?? [];
}
