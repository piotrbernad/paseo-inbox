// What makes a question one a person can decide on from their phone without opening anything.
// Each rule is conservative: it refuses only what is clearly wrong, and its hint says what to do.

export type Draft = {
  title: string;
  context: string;
  options: readonly { key: string; text: string }[];
  ref: string | null;
};

export function questionRefusal(draft: Draft): string | null {
  return titleRefusal(draft.title, draft.ref) ?? pathRefusal(draft) ?? oneDecisionRefusal(draft.title, draft.options);
}

// A title that starts with the ref or a ticket id ("GUN-368 …", "[ABC-12] …").
function titleRefusal(title: string, ref: string | null): string | null {
  const trimmedRef = ref?.trim() ?? "";
  const lead = title.replace(/^[[(\s]+/, "");
  const id = /^[A-Z]+-\d+/.exec(lead)?.[0];
  const startsWithRef = trimmedRef !== "" && lead.toLowerCase().startsWith(trimmedRef.toLowerCase());
  const prefix = startsWithRef ? trimmedRef : id;
  if (prefix === undefined) return null;
  return (
    `The title starts with ${prefix}. The ref has its own field (--ref); the title says what is being ` +
    "decided, in the person's words."
  );
}

function pathRefusal({ title, context, options }: Draft): string | null {
  const fields = [
    ["The title", title],
    ["The context", context],
    ...options.map((o) => [`Option ${o.key}`, o.text]),
  ] as const;
  for (const [what, text] of fields) {
    const path = localPath(text);
    if (path !== null) {
      return (
        `${what} names a local path (${path}). The person cannot open files on your machine, least of all ` +
        "on a phone: link it with https:// (for example on GitHub), or put the fact into the question."
      );
    }
  }
  return null;
}

const KNOWN_DIRS = new Set(["agents", "docs", "scripts", "src", "node_modules"]);
const ROOTS = new Set(["tmp", "Users", "home", "var", "etc", "opt", "private", "Volumes"]);
const FILE_EXTENSION = /\.(md|mdx|txt|json|jsonl|ya?ml|toml|ini|env|lock|log|csv|tsv|sql|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|ex|exs|eex|heex|sh|zsh|bash|html|css|scss|xml|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|zip|tar|gz)$/i;

// The first token that is a filesystem path, or null. A path is absolute (/a/b, /tmp, /x.md),
// under home (~/…), explicitly relative (./…, ../…), a file:// URL, or a word with a slash that
// ends in a file extension (dir/BRIEF.md) or starts with a known local dir (.context/…, agents/…).
// http(s) URLs, fractions (1/3), pairs (A/B, km/h, and/or) and dates (18/10/2026) are not paths.
export function localPath(text: string): string | null {
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[("'`[<{]+/, "").replace(/[)"'`\]>}.,;:!?]+$/, "");
    if (isPath(token)) return token;
  }
  return null;
}

function isPath(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return false;
  if (/^file:\/\//i.test(token)) return true;
  if (/^~\//.test(token) || /^\.\.?\//.test(token)) return true;
  const segments = token.split("/");
  if (segments.length < 2) return false;
  if (token.startsWith("/")) {
    const parts = segments.filter((s) => s !== "");
    if (parts.length === 1) return ROOTS.has(parts[0]) || FILE_EXTENSION.test(parts[0]);
    return parts.length > 1 && /\p{L}/u.test(parts[0]);
  }
  const [first] = segments;
  return /^\.[\p{L}\p{N}_-]+$/u.test(first) || KNOWN_DIRS.has(first) || FILE_EXTENSION.test(segments[segments.length - 1]);
}

// "5 recommendations" in the title and "accept all" among the options: several decisions behind
// one question. A count is a whole number of at least 2 followed by a word, not part of a decimal,
// a range or an id.
const COUNT = /(?<![\p{L}\p{N}.,:/-])([2-9]|[1-9]\d+)\s+\p{L}/u;
const ALL = /(?<![\p{L}\p{N}])(all|wszystkie|wszystkich)(?![\p{L}\p{N}])/iu;

function oneDecisionRefusal(title: string, options: Draft["options"]): string | null {
  const count = COUNT.exec(title)?.[1];
  if (count === undefined) return null;
  const option = options.find((o) => ALL.test(o.text));
  if (option === undefined) return null;
  return (
    `The title counts ${count} things and option ${option.key} takes them all at once. Ask one question per ` +
    "decision, each with its own options, so the person can answer each on its own."
  );
}
