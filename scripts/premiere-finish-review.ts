#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  PremiereFinishReviewError,
  projectPremiereFinishReview,
} from "../runtime/handoff/premiere-finish-review.js";

export function main(argv = process.argv): number {
  try {
    const args = argv.slice(2);
    if (args.length !== 2 || args[1] !== "--json" || args[0].startsWith("-")) {
      throw new PremiereFinishReviewError("invalid_projection", "usage: premiere-finish-review <project> --json");
    }
    const projection = projectPremiereFinishReview(args[0]);
    process.stdout.write(`${JSON.stringify(projection)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof PremiereFinishReviewError ? error.code : "invalid_projection";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ version: "premiere-finish-review-error/v1", code, message })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
