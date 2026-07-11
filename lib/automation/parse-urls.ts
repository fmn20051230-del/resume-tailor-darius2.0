const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function parseJobUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of Array.from(text.matchAll(URL_RE))) {
    let url = match[0].replace(/[.,;:!?)]+$/, "").trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }

  return urls;
}
