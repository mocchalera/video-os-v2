#!/usr/bin/env node
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "video-os-public-secret-scanner/v1";

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  fail("scanner canonical JSON received an unsupported value");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, "utf8");
}

function parseArgs(argv) {
  const allowed = new Set(["--staging", "--rules", "--target-payload-sha256"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key)) fail(`unknown scanner argument: ${String(key)}`);
    if (!value || value.startsWith("--")) fail(`missing scanner value for ${key}`);
    if (values.has(key)) fail(`duplicate scanner argument: ${key}`);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) fail(`missing scanner argument: ${key}`);
  const targetPayloadSha256 = values.get("--target-payload-sha256");
  if (!/^[0-9a-f]{64}$/.test(targetPayloadSha256)) fail("target payload digest is invalid");
  return {
    staging: fs.realpathSync(values.get("--staging")),
    rules: fs.realpathSync(values.get("--rules")),
    targetPayloadSha256,
  };
}

function readRules(rulesPath) {
  const bytes = fs.readFileSync(rulesPath);
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(canonicalBytes(parsed))) fail("scanner rules are not canonical JSON");
  if (parsed?.version !== "public-projection-secret-rules/v1" || !Array.isArray(parsed.rules)) {
    fail("unsupported scanner rules contract");
  }
  const seen = new Set();
  const rules = parsed.rules.map((rule) => {
    if (!rule || Object.keys(rule).sort().join(",") !== "flags,id,pattern_b64") {
      fail("scanner rule has unexpected keys");
    }
    if (!/^[a-z0-9-]+$/.test(rule.id) || seen.has(rule.id)) fail("scanner rule ID is invalid or duplicate");
    seen.add(rule.id);
    if (rule.flags !== "g" && rule.flags !== "gi") fail(`scanner rule ${rule.id} has unsafe flags`);
    const patternBytes = Buffer.from(rule.pattern_b64, "base64");
    if (patternBytes.length === 0 || patternBytes.toString("base64") !== rule.pattern_b64) {
      fail(`scanner rule ${rule.id} has invalid pattern bytes`);
    }
    return { id: rule.id, expression: new RegExp(patternBytes.toString("utf8"), rule.flags) };
  });
  const ordered = [...rules].sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (ordered.some((rule, index) => rule.id !== rules[index].id)) fail("scanner rules are not ordered by ID");
  return { bytes, rules };
}

function joinBuffer(parent, name) {
  return Buffer.concat([parent, Buffer.from(path.sep), name]);
}

function scan(stagingRoot, rules) {
  const root = fs.realpathSync(stagingRoot, { encoding: "buffer" });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o222) !== 0) fail("staging root must be an immutable directory");
  const findings = [];
  const walk = (directory, relative) => {
    const entries = fs.readdirSync(directory, { encoding: "buffer", withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(left.name, right.name));
    for (const entry of entries) {
      const child = joinBuffer(directory, entry.name);
      const childRelative = relative.length === 0 ? entry.name : joinBuffer(relative, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o222) !== 0) fail("staging directory became writable during scan");
        walk(child, childRelative);
        continue;
      }
      let bytes;
      if (stat.isSymbolicLink()) {
        bytes = fs.readlinkSync(child, { encoding: "buffer" });
      } else if (stat.isFile()) {
        if ((stat.mode & 0o222) !== 0 || stat.nlink !== 1) fail("staging file identity is not immutable");
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const descriptor = fs.openSync(child, fs.constants.O_RDONLY | noFollow);
        try {
          const held = fs.fstatSync(descriptor);
          if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino || held.nlink !== 1) {
            fail("staging file changed while opening for scan");
          }
          bytes = fs.readFileSync(descriptor);
          const after = fs.fstatSync(descriptor);
          if (after.dev !== held.dev || after.ino !== held.ino || after.size !== held.size || after.mtimeMs !== held.mtimeMs) {
            fail("staging file changed during scan");
          }
        } finally {
          fs.closeSync(descriptor);
        }
      } else {
        fail("staging contains an unsupported path type");
      }
      const text = bytes.toString("latin1");
      for (const rule of rules) {
        rule.expression.lastIndex = 0;
        for (const match of text.matchAll(rule.expression)) {
          const offset = match.index ?? 0;
          findings.push({
            line: 1 + text.slice(0, offset).split("\n").length - 1,
            match_sha256: sha256(Buffer.from(match[0], "latin1")),
            offset,
            path_b64: childRelative.toString("base64"),
            rule_id: rule.id,
          });
        }
      }
    }
  };
  walk(root, Buffer.alloc(0));
  findings.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path_b64, "base64"), Buffer.from(right.path_b64, "base64"))
      || left.offset - right.offset
      || left.rule_id.localeCompare(right.rule_id, "en")
  );
  return findings;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scannerPath = fs.realpathSync(fileURLToPath(import.meta.url));
  const rules = readRules(args.rules);
  const findings = scan(args.staging, rules.rules);
  const result = {
    findings,
    result: {
      exit_code: findings.length === 0 ? 0 : 2,
      finding_count: findings.length,
      status: findings.length === 0 ? "clean" : "findings",
    },
    scanner: {
      binary_sha256: sha256(fs.readFileSync(scannerPath)),
      name: "video-os-repository-secret-scanner",
      rules_sha256: sha256(rules.bytes),
      version: VERSION,
    },
    target_payload_sha256: args.targetPayloadSha256,
    version: "public-projection-secret-scan-result/v1",
  };
  process.stdout.write(canonicalBytes(result));
  process.exitCode = result.result.exit_code;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
