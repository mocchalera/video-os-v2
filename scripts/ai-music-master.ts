#!/usr/bin/env npx tsx

/**
 * AI-music dedicated mastering CLI (Issue #38).
 *
 * Runs the dedicated 3-stage tone chain (cleanup / presence-air /
 * spatial-glue) and, for the standalone SNS route, an EBU R128 two-pass
 * loudnorm at the internal target -13.3 LUFS (processing at -2.0 dBTP,
 * acceptance verified at TP <= -1.0 dBTP) with fail-closed acceptance
 * verification and a schema-validated receipt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AiMusicMasteringCapabilityError,
  AiMusicMasteringVerificationError,
  masterAiMusic,
  resolveAiMusicMasteringPolicy,
  validateAiMusicMasteringReceipt,
} from "../runtime/audio/ai-music-mastering.js";

export const AI_MUSIC_MASTER_USAGE = `Usage:
  npm run ai-music-master -- --input <audio-file> --output-dir <dir> [options]

Options:
  --route <route>   standalone_sns_master (default: 2-pass loudnorm -13.3 LUFS, acceptance TP <= -1.0 dBTP)
                    | source_premaster (tone chain only, no loudness normalization)
  --policy <file>   Optional JSON policy overrides (validated fail-closed).
                    On standalone_sns_master the Issue #38 contract fields
                    (loudness/true-peak targets, tolerance, LRA) are
                    shipped-only and rejected before any processing.
  --no-mp3          Skip the 320 kbps MP3 delivery encode
  --receipt <path>  Receipt path (default: <output-dir>/ai-music-mastering-receipt.json)
  --verify-receipt <path>
                    Do not master: validate an existing receipt with the
                    schema plus the semantic integrity validator (recomputed
                    booleans/status). Exit 0 valid, 4 tampered/invalid.
  --json            Print JSON
  -h, --help        Show this help`;

interface Args {
  inputPath?: string;
  outputDir?: string;
  route?: string;
  policyPath?: string;
  noMp3: boolean;
  receiptPath?: string;
  verifyReceiptPath?: string;
  json: boolean;
}

export function parseAiMusicMasterArgs(argv: string[]): Args {
  const values = argv.slice(2);
  let inputPath: string | undefined;
  let outputDir: string | undefined;
  let route: string | undefined;
  let policyPath: string | undefined;
  let noMp3 = false;
  let receiptPath: string | undefined;
  let verifyReceiptPath: string | undefined;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--input") inputPath = required(values, ++index, flag);
    else if (flag === "--output-dir") outputDir = required(values, ++index, flag);
    else if (flag === "--route") route = required(values, ++index, flag);
    else if (flag === "--policy") policyPath = required(values, ++index, flag);
    else if (flag === "--no-mp3") noMp3 = true;
    else if (flag === "--receipt") receiptPath = required(values, ++index, flag);
    else if (flag === "--verify-receipt") verifyReceiptPath = required(values, ++index, flag);
    else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") throw new Error(AI_MUSIC_MASTER_USAGE);
    else throw new Error(`unknown argument: ${flag}\n${AI_MUSIC_MASTER_USAGE}`);
  }
  if (!verifyReceiptPath) {
    if (!inputPath) throw new Error(`--input is required\n${AI_MUSIC_MASTER_USAGE}`);
    if (!outputDir) throw new Error(`--output-dir is required\n${AI_MUSIC_MASTER_USAGE}`);
  }
  return {
    inputPath: inputPath ? path.resolve(inputPath) : undefined,
    outputDir: outputDir ? path.resolve(outputDir) : undefined,
    route,
    policyPath: policyPath ? path.resolve(policyPath) : undefined,
    noMp3,
    receiptPath: receiptPath ? path.resolve(receiptPath) : undefined,
    verifyReceiptPath: verifyReceiptPath ? path.resolve(verifyReceiptPath) : undefined,
    json,
  };
}

/** Verify-only mode: schema + semantic integrity on the bytes on disk. */
function runReceiptVerification(receiptPath: string, json: boolean): number {
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (error) {
    console.error(
      `[ai-music-master] receipt is unreadable or not JSON: ${receiptPath} (${error instanceof Error ? error.message : String(error)})`,
    );
    return 4;
  }
  const validation = validateAiMusicMasteringReceipt(document);
  if (json) {
    console.log(JSON.stringify({ receipt_path: receiptPath, ...validation }, null, 2));
  } else if (validation.valid) {
    console.log(`[ai-music-master] receipt valid (schema + integrity): ${receiptPath}`);
  } else {
    console.error(
      `[ai-music-master] receipt failed schema/integrity validation: ${receiptPath}\n  ${validation.errors.join("\n  ")}`,
    );
  }
  return validation.valid ? 0 : 4;
}

export async function runAiMusicMasterCli(argv = process.argv): Promise<number> {
  if (argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    console.log(AI_MUSIC_MASTER_USAGE);
    return 0;
  }
  try {
    const args = parseAiMusicMasterArgs(argv);
    if (args.verifyReceiptPath) {
      return runReceiptVerification(args.verifyReceiptPath, args.json);
    }
    if (!args.inputPath || !args.outputDir) {
      throw new Error(`--input and --output-dir are required\n${AI_MUSIC_MASTER_USAGE}`);
    }
    let policyOverrides: unknown = {};
    if (args.policyPath) {
      policyOverrides = JSON.parse(fs.readFileSync(args.policyPath, "utf8"));
    }
    if (args.route !== undefined) {
      policyOverrides = { ...(policyOverrides as Record<string, unknown>), route: args.route };
    }
    if (args.noMp3) {
      policyOverrides = { ...(policyOverrides as Record<string, unknown>), encode_mp3_320: false };
    }
    const policy = resolveAiMusicMasteringPolicy(policyOverrides);
    const receipt = await masterAiMusic({
      inputPath: args.inputPath,
      outputDir: args.outputDir,
      policy,
      receiptPath: args.receiptPath,
    });
    const result = {
      success: true,
      state: receipt.state,
      route: receipt.route,
      output_path: receipt.output_audio?.path ?? null,
      mp3_output_path: receipt.mp3_output_audio?.path ?? null,
      integrated_lufs: receipt.output_measurement?.integrated_lufs ?? null,
      true_peak_dbtp: receipt.output_measurement?.true_peak_dbtp ?? null,
      verification: receipt.verification?.status ?? null,
      receipt_path: path.resolve(args.receiptPath ?? path.join(args.outputDir, "ai-music-mastering-receipt.json")),
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : [
      `[ai-music-master] ${receipt.state}`,
      `output: ${result.output_path ?? "-"}`,
      `integrated: ${result.integrated_lufs} LUFS (target ${receipt.policy.loudness_target_lufs} ± ${receipt.policy.loudness_tolerance_lufs})`,
      `true peak: ${result.true_peak_dbtp} dBTP (limit ${receipt.policy.true_peak_target_dbtp})`,
      `human audition: required (phone-speaker vocal clarity is not machine-claimable)`,
    ].join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof AiMusicMasteringCapabilityError) {
      console.error(`[ai-music-master] capability unavailable: ${error.message}`);
      return 2;
    }
    if (error instanceof AiMusicMasteringVerificationError) {
      console.error(`[ai-music-master] ${error.message}`);
      const rejectedOutput = error.receipt.output_audio?.path;
      console.error(
        rejectedOutput
          ? `[ai-music-master] rejected deliverable (kept as evidence): ${rejectedOutput}`
          : "[ai-music-master] no deliverable was produced",
      );
      return 3;
    }
    console.error(`[ai-music-master] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function required(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runAiMusicMasterCli().then((code) => { process.exitCode = code; });
}
