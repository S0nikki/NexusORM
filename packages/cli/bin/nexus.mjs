#!/usr/bin/env node
import { runCli } from "../dist/index.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error(`[Nexus CLI Error] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
