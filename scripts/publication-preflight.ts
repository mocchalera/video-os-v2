import { pathToFileURL } from "node:url";
import { runPublicationPreflight, type PublicationDestination } from "../runtime/packaging/publication-preflight.js";

function usage(): never {
  console.error("Usage: npm run publication-preflight -- <project-dir> [--platform youtube] [--visibility unlisted]");
  process.exit(2);
}

export function parsePublicationPreflightArgs(argv: string[]): {
  projectDir: string;
  platform?: PublicationDestination["platform"];
  visibility?: PublicationDestination["visibility"];
} {
  const projectDir = argv[0];
  if (!projectDir) usage();
  let platform: PublicationDestination["platform"] | undefined;
  let visibility: PublicationDestination["visibility"] | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--platform" && argv[index + 1]) platform = argv[++index] as typeof platform;
    else if (argv[index] === "--visibility" && argv[index + 1]) visibility = argv[++index] as typeof visibility;
    else usage();
  }
  if ((platform && !visibility) || (!platform && visibility)) usage();
  return { projectDir, platform, visibility };
}

export function main(argv = process.argv.slice(2)): void {
  const args = parsePublicationPreflightArgs(argv);
  const result = runPublicationPreflight(
    args.projectDir,
    args.platform && args.visibility
      ? { platform: args.platform, visibility: args.visibility }
      : undefined,
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
