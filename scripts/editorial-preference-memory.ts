#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import {
  migrateLegacyPreferenceMemory,
  redactEditorialPreference,
  rememberEditorialPreference,
  type PrimitivePreferenceValue,
  type RememberEditorialPreferenceInput,
  type WritablePreferenceScope,
  type WritablePreferenceType,
} from "../runtime/artifacts/p3-preference-memory.js";

export const EDITORIAL_PREFERENCE_MEMORY_USAGE = [
  "Usage:",
  "  npx tsx scripts/editorial-preference-memory.ts migrate --project <dir> --project-id <id> [--json]",
  "  npx tsx scripts/editorial-preference-memory.ts remember --project <dir> --project-id <id> --action-id <id> --actor-id <id> --source-event <blueprint_acceptance|review_patch_acceptance|review_patch_rejection> --source <project artifact> --type <feature> --kind <string|enum|number|boolean> --value <primitive> --scope <project|profile|series> --scope-ref <id> [--supersedes <entry-id>] [--created-at <ISO date>] [--json]",
  "  npx tsx scripts/editorial-preference-memory.ts redact --project <dir> --project-id <id> --action-id <id> --actor-id <id> --target <entry-id> --reason <text> [--created-at <ISO date>] [--json]",
].join("\n");

type CommonArgs = { projectDir: string; projectId: string; json: boolean };
export type EditorialPreferenceMemoryCliArgs =
  | ({ command: "migrate" } & CommonArgs)
  | ({ command: "remember" } & CommonArgs & Omit<RememberEditorialPreferenceInput, "projectDir" | "projectId">)
  | ({ command: "redact" } & CommonArgs & {
      actionId: string;
      actorId: string;
      targetEntryId: string;
      reason: string;
      createdAt?: string;
    })
  | { command: "help"; json: boolean };

const VALUE_OPTIONS = new Set(["string", "enum", "number", "boolean"]);
const TYPE_OPTIONS = new Set([
  "pacing", "chronology", "transition_style", "repetition_tolerance",
  "bgm_loudness", "caption_density", "delivery_preference",
]);
const SCOPE_OPTIONS = new Set(["project", "profile", "series"]);
const EVENT_OPTIONS = new Set(["blueprint_acceptance", "review_patch_acceptance", "review_patch_rejection"]);

export function parseEditorialPreferenceMemoryArgs(argv: string[] = process.argv.slice(2)): EditorialPreferenceMemoryCliArgs {
  const args = argv[0]?.includes("editorial-preference-memory") ? argv.slice(2) : argv;
  const command = args[0];
  const json = args.includes("--json");
  if (!command || command === "--help" || command === "-h" || command === "help") return { command: "help", json };
  if (command !== "migrate" && command !== "remember" && command !== "redact") {
    throw new Error(`Unknown command: ${command}\n${EDITORIAL_PREFERENCE_MEMORY_USAGE}`);
  }
  const values = parseOptions(args.slice(1));
  const common = {
    projectDir: required(values, "project"),
    projectId: required(values, "project-id"),
    json,
  };
  if (command === "migrate") {
    rejectUnknown(values, new Set(["project", "project-id", "json"]));
    return { command, ...common };
  }
  const actionId = required(values, "action-id");
  const actorId = required(values, "actor-id");
  const createdAt = optional(values, "created-at");
  if (createdAt && !Number.isFinite(Date.parse(createdAt))) throw new Error("--created-at must be an ISO-compatible date-time");
  if (command === "redact") {
    rejectUnknown(values, new Set(["project", "project-id", "action-id", "actor-id", "target", "reason", "created-at", "json"]));
    return {
      command,
      ...common,
      actionId,
      actorId,
      targetEntryId: required(values, "target"),
      reason: required(values, "reason"),
      ...(createdAt ? { createdAt } : {}),
    };
  }
  rejectUnknown(values, new Set([
    "project", "project-id", "action-id", "actor-id", "source-event", "source", "type", "kind",
    "value", "scope", "scope-ref", "supersedes", "created-at", "json",
  ]));
  const sourceEvent = oneOf(required(values, "source-event"), EVENT_OPTIONS, "--source-event") as RememberEditorialPreferenceInput["sourceEvent"];
  const preferenceType = oneOf(required(values, "type"), TYPE_OPTIONS, "--type") as WritablePreferenceType;
  const kind = oneOf(required(values, "kind"), VALUE_OPTIONS, "--kind") as PrimitivePreferenceValue["kind"];
  const scope = oneOf(required(values, "scope"), SCOPE_OPTIONS, "--scope") as WritablePreferenceScope;
  return {
    command,
    ...common,
    actionId,
    actorId,
    sourceEvent,
    sourceArtifactPath: required(values, "source"),
    preferenceType,
    value: parsePrimitive(kind, required(values, "value")),
    scope,
    scopeRef: required(values, "scope-ref"),
    ...(optional(values, "supersedes") ? { supersedesEntryId: optional(values, "supersedes") } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function runEditorialPreferenceMemoryCli(args: EditorialPreferenceMemoryCliArgs): unknown {
  switch (args.command) {
    case "help":
      return { command: "help", usage: EDITORIAL_PREFERENCE_MEMORY_USAGE };
    case "migrate":
      return migrateLegacyPreferenceMemory(args.projectDir, args.projectId);
    case "remember": {
      const { command: _command, json: _json, ...input } = args;
      return rememberEditorialPreference(input);
    }
    case "redact": {
      const { command: _command, json: _json, ...input } = args;
      return redactEditorialPreference(input);
    }
  }
}

function parseOptions(args: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    if (key === "json") {
      values.set(key, true);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
  }
  return values;
}

function required(values: Map<string, string | true>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing --${key}.\n${EDITORIAL_PREFERENCE_MEMORY_USAGE}`);
  return value;
}

function optional(values: Map<string, string | true>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" ? value : undefined;
}

function rejectUnknown(values: Map<string, string | true>, allowed: Set<string>): void {
  const unknown = [...values.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown option: --${unknown}`);
}

function oneOf(value: string, allowed: Set<string>, label: string): string {
  if (!allowed.has(value)) throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  return value;
}

function parsePrimitive(kind: PrimitivePreferenceValue["kind"], raw: string): PrimitivePreferenceValue {
  if (kind === "number") return { kind, data: Number(raw) };
  if (kind === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error("--value must be true or false for boolean kind");
    return { kind, data: raw === "true" };
  }
  return { kind, data: raw };
}

export interface EditorialPreferenceMemoryCliIO {
  log(message: string): void;
  error(message: string): void;
}

export function main(
  argv: string[] = process.argv.slice(2),
  io: EditorialPreferenceMemoryCliIO = console,
): number {
  try {
    const args = parseEditorialPreferenceMemoryArgs(argv);
    const result = runEditorialPreferenceMemoryCli(args);
    if (args.json) io.log(JSON.stringify(result, null, 2));
    else if (args.command === "help") io.log(EDITORIAL_PREFERENCE_MEMORY_USAGE);
    else io.log(JSON.stringify(result, null, 2));
    if (args.command === "migrate" && result && typeof result === "object" && "status" in result) {
      return result.status === "conflict" || result.status === "rejected" ? 1 : 0;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.error(argv.includes("--json") ? JSON.stringify({ ok: false, error: message }) : message);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
