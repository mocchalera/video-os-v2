export const USAGE = "Usage: good [--help-only]";

export function parseArgs(args: string[]): void {
  for (const arg of args) {
    if (arg === "--good") continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
}
