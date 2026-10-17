import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The Paseo desktop app bundles Node and the CLI's connection code. Using them means users install
// nothing, and pairing links work exactly as they do with `paseo --host`.

export function paseoResources(): string {
  const candidates = [
    process.env.PASEO_RESOURCES,
    // The daemon and its plugin workers run on ".../Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper".
    process.execPath.includes("/Contents/Frameworks/")
      ? join(process.execPath.slice(0, process.execPath.indexOf("/Contents/Frameworks/")), "Contents/Resources")
      : undefined,
    "/Applications/Paseo.app/Contents/Resources",
    join(process.env.HOME ?? "", "Applications/Paseo.app/Contents/Resources"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "app.asar"))) return candidate;
  }
  throw new Error("Paseo.app not found. Set PASEO_RESOURCES to its Contents/Resources directory.");
}

export function bundledModule(resources: string, path: string): string {
  return pathToFileURL(join(resources, "app.asar/node_modules", path)).href;
}
