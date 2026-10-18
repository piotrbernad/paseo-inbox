export type Segment = { kind: "text"; text: string } | { kind: "link"; url: string };

const LINK = /https?:\/\/[^\s<>"'`]+/gi;

// Text split into plain runs and http(s) links. A link ends before trailing punctuation and before
// a closing bracket it did not open, so "(see https://x.y/z)." links https://x.y/z.
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    const url = trimUrl(match[0]);
    const start = match.index;
    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    out.push({ kind: "link", url });
    at = start + url.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (/[.,;:!?*_]/.test(last)) end--;
    else if ((last === ")" || last === "]") && count(url.slice(0, end), last === ")" ? "(" : "[") < count(url.slice(0, end), last)) end--;
    else return url.slice(0, end);
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

export function links(text: string): string[] {
  return [...new Set(segments(text).flatMap((s) => (s.kind === "link" ? [s.url] : [])))];
}

// Where to load a preview of an image link from, or null when the link is not an image: a path
// ending in .png, .jpg, .jpeg, .webp or .gif, or a GitHub attachment. A GitHub "blob" page of an
// image is loaded from its "raw" address. (React Native's URL cannot read a host or path.)
export function imageSource(url: string): string | null {
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!parts) return null;
  const host = parts[1].toLowerCase();
  const path = parts[2];
  if (host === "github.com" && path.startsWith("/user-attachments/assets/")) return url;
  if (/^(private-)?user-images\.githubusercontent\.com$/.test(host)) return url;
  if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) return null;
  if (host === "github.com") return url.replace(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//i, "$1/raw/");
  return url;
}
