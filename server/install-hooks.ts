import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Claude Code's settings.json and Codex's hooks.json share this shape:
// { "hooks": { "<Event>": [{ "matcher"?: "...", "hooks": [{ "type": "command", "command": "..." }] }] } }
const EVENTS = ["UserPromptSubmit", "PostToolUse"] as const;
// Seconds; generous, and unchanged so that Codex keeps trusting the installed hook.
const TIMEOUT_S = 30;

type Json = Record<string, unknown>;
type Handler = { type?: unknown; command?: unknown };
type Group = { matcher?: unknown; hooks?: Handler[] };

export function hookCommand(launcher: string): string {
  const quoted = /^[\w./~-]+$/.test(launcher) ? launcher : `'${launcher.replace(/'/g, `'\\''`)}'`;
  return `${quoted} hook`;
}

function isInboxHandler(handler: Handler, command: string): boolean {
  return typeof handler.command === "string" && (handler.command === command || /(^|\/)paseo-inbox'? hook$/.test(handler.command));
}

function groupsOf(settings: Json, event: string): Group[] {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const groups = (hooks as Json)[event];
  return Array.isArray(groups) ? (groups as Group[]) : [];
}

// No matcher on PostToolUse: every tool.
export function withInboxHooks(settings: Json, command: string): Json {
  const hooks = { ...((settings.hooks as Json | undefined) ?? {}) };
  for (const event of EVENTS) {
    const groups = groupsOf(settings, event);
    if (groups.some((g) => (g.hooks ?? []).some((h) => isInboxHandler(h, command)))) continue;
    hooks[event] = [...groups, { hooks: [{ type: "command", command, timeout: TIMEOUT_S }] }];
  }
  return { ...settings, hooks };
}

export function withoutInboxHooks(settings: Json, command: string): Json {
  if (typeof settings.hooks !== "object" || settings.hooks === null) return settings;
  const hooks = { ...(settings.hooks as Json) };
  for (const event of EVENTS) {
    if (!(event in hooks)) continue;
    const groups = groupsOf(settings, event)
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isInboxHandler(h, command)) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export type Outcome = "added" | "already installed" | "removed" | "not installed";

// Rewrites the file only when something changes, after copying it to <path>.bak-<time>.
export async function updateHookFile(
  link: string,
  command: string,
  uninstall: boolean,
  now: Date,
): Promise<{ outcome: Outcome; backup: string | null }> {
  // Settings kept in a dotfiles repo are often symlinks: write the file they point to.
  const path = await realpath(link).catch(() => link);
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let current: Json = {};
  if (raw !== null && raw.trim() !== "") {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object.`);
    current = parsed as Json;
  }
  const next = uninstall ? withoutInboxHooks(current, command) : withInboxHooks(current, command);
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { outcome: uninstall ? "not installed" : "already installed", backup: null };
  }
  await mkdir(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (raw !== null) {
    backup = `${path}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backup);
  }
  const draft = `${path}.${process.pid}.tmp`;
  await writeFile(draft, `${JSON.stringify(next, null, 2)}\n`);
  const mode = await stat(path).then((s) => s.mode & 0o777, () => null);
  if (mode !== null) await chmod(draft, mode);
  await rename(draft, path);
  return { outcome: uninstall ? "removed" : "added", backup };
}
