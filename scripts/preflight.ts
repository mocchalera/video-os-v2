#!/usr/bin/env npx tsx

import { pathToFileURL } from "node:url";
export * from "../runtime/preflight.js";
import { runPreflightCli } from "../runtime/preflight.js";

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runPreflightCli(process.argv);
}
