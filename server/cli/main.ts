import { registerHooks } from "node:module";
import { bundledModule, paseoResources } from "../paseo-app.ts";

// The launcher runs this file with the Node inside Paseo.app, where no node_modules sits next to
// this package. Resolve bare imports (zod) from the app bundle instead, before loading anything
// that imports them.
const appParent = bundledModule(paseoResources(), "@getpaseo/cli/package.json");
registerHooks({
  resolve(specifier, context, next) {
    if (/^(zod)(\/|$)/.test(specifier)) return next(specifier, { ...context, parentURL: appParent });
    return next(specifier, context);
  },
});

const { main } = await import("./commands.ts");
process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
