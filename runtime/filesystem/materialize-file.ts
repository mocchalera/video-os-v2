import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export type FileMaterializationMethod = "clone" | "copy";

export interface MaterializeFileOptions {
  exclusive?: boolean;
}

const CLONE_UNSUPPORTED_CODES = new Set([
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EINVAL",
  "EXDEV",
]);

/**
 * Materialize an independent file while preferring a filesystem copy-on-write
 * clone. The clone path preserves byte identity but avoids reading and writing
 * an entire long-form video on APFS and other reflink-capable filesystems.
 */
export function materializeFileSync(
  sourcePath: string,
  destinationPath: string,
  options: MaterializeFileOptions = {},
): FileMaterializationMethod {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error("materialize source and destination must differ");
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const exclusiveFlag = options.exclusive ? fs.constants.COPYFILE_EXCL : 0;
  try {
    fs.copyFileSync(
      source,
      destination,
      exclusiveFlag | fs.constants.COPYFILE_FICLONE_FORCE,
    );
    return "clone";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !CLONE_UNSUPPORTED_CODES.has(code)) throw error;
  }

  // Node currently reports ENOSYS for COPYFILE_FICLONE_FORCE on macOS even
  // when the underlying APFS volume supports clonefile(2). BSD cp exposes that
  // primitive as `cp -c`, so keep the zero-copy path available without routing
  // file names through a shell.
  if (process.platform === "darwin") {
    if (options.exclusive && fs.existsSync(destination)) {
      const error = new Error(`materialize destination already exists: ${destination}`) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    const clone = spawnSync("/bin/cp", ["-c", source, destination], {
      encoding: "utf8",
    });
    if (clone.status === 0) return "clone";
    fs.rmSync(destination, { force: true });
  }

  fs.copyFileSync(source, destination, exclusiveFlag);
  return "copy";
}
