import { main } from "../server/cli/commands.ts";

// Runs the CLI in its own process, as agents do, but with plain Node and no Paseo daemon.
process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  connect: async () => {
    throw new Error("no Paseo daemon in this test");
  },
});
