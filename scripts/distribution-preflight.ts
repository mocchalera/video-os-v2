#!/usr/bin/env node
import * as fs from "node:fs";
import { evaluateDistributionPreflight, serializeDistributionDecision, type DistributionPreflightRequest } from "../runtime/distribution/preflight.js";

const requestPath = process.argv[2];
if (!requestPath) {
  console.error("Usage: npx tsx scripts/distribution-preflight.ts <request.json>");
  process.exitCode = 2;
} else {
  try {
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as DistributionPreflightRequest;
    const decision = evaluateDistributionPreflight(request);
    process.stdout.write(serializeDistributionDecision(decision));
    if (decision.decision === "BLOCK") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
