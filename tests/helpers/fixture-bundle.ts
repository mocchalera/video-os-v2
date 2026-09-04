import { buildSync } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Bundle a TS fixture (and its runtime imports) into a standalone ESM .mjs so
 * the test can spawn it with PLAIN `node` — no tsx loader, which would spawn
 * an esbuild service INTO the child's process group and make macOS refuse
 * group signals (EPERM) with live members. Bundling keeps the exercised code
 * identical to the real runtime modules.
 */
const bundled = new Map<string, string>();

export function bundleFixture(
  entryPath: string,
  outDir: string,
  options: {
    format?: "esm" | "cjs";
    external?: string[];
    externalizePackages?: boolean;
  } = {},
): string {
  const canonicalEntry = path.resolve(entryPath);
  const canonicalOutDir = path.resolve(outDir);
  const format = options.format ?? "esm";
  const extension = format === "cjs" ? ".cjs" : ".mjs";
  const external = [...(options.external ?? [])].sort();
  const externalizePackages = options.externalizePackages === true;
  const cacheKey = `${canonicalEntry}\u0000${canonicalOutDir}\u0000${format}`
    + `\u0000${externalizePackages ? "packages-external" : "packages-bundled"}`
    + `\u0000${external.join("\u0001")}`;
  const cached = bundled.get(cacheKey);
  if (cached && fs.existsSync(cached)) return cached;
  fs.mkdirSync(canonicalOutDir, { recursive: true });
  const outfile = path.join(canonicalOutDir, `${path.basename(entryPath).replace(/\.ts$/, "")}${extension}`);
  buildSync({
    entryPoints: [canonicalEntry],
    bundle: true,
    platform: "node",
    format,
    target: "node22",
    // Public command fixtures pull in the optional Remotion/Rspack graph.
    // Copy native bindings as test-owned assets so a plain Node child can
    // exercise that public entry without a loader-side process.
    loader: { ".node": "copy" },
    external,
    ...(externalizePackages ? { packages: "external" as const } : {}),
    outfile,
    logLevel: "silent",
    sourcemap: false,
  });
  bundled.set(cacheKey, outfile);
  return outfile;
}
