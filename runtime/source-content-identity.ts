import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const HASH_BUFFER_SIZE = 4 * 1024 * 1024;

export interface SourceContentIdentity {
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
}

export class SourceContentIntegrityError extends Error {
  readonly code = "SOURCE_CONTENT_INTEGRITY_FAILED";
  constructor(readonly reason: "missing_or_unreadable" | "not_regular_file" | "content_changed") {
    super(`source_content_integrity_failed:${reason}`);
    this.name = "SourceContentIntegrityError";
  }
}

/** The single owner of full source-content hashing used by ingest and visual caches. */
export function sha256FileHex(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  const hash = createHash("sha256");
  const fd = fs.openSync(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE);
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function sha256FileUri(filePath: string): string {
  return `sha256:${sha256FileHex(filePath)}`;
}

/** Shares one full-file hash for each source during a single pipeline run. */
export class SourceContentIdentityCache {
  private readonly identities = new Map<string, SourceContentIdentity>();

  constructor(private readonly hashFile: (filePath: string) => string = sha256FileHex) {}

  prime(identity: SourceContentIdentity): void {
    this.identities.set(path.resolve(identity.absolutePath), {
      ...identity,
      absolutePath: path.resolve(identity.absolutePath),
    });
  }

  resolve(filePath: string): SourceContentIdentity {
    const absolutePath = path.resolve(filePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`source_content_identity_requires_file:${absolutePath}`);
    }
    const sizeBytes = stat.size;
    const mtimeMs = Math.round(stat.mtimeMs);
    const cached = this.identities.get(absolutePath);
    // This stat guard avoids a second full read during an unchanged run while
    // invalidating normal edits. It cannot detect adversarial byte replacement
    // that deliberately preserves both size and mtime; detecting that requires
    // rehashing every resolve and forfeiting the single-hash pipeline contract.
    if (cached && cached.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) return cached;

    const identity: SourceContentIdentity = {
      absolutePath,
      sha256: this.hashFile(absolutePath),
      sizeBytes,
      mtimeMs,
    };
    this.identities.set(absolutePath, identity);
    return identity;
  }

  /** Assert the ingest identity before an optional model consumes source media. */
  assertExpected(filePath: string, expectedSha256: string): SourceContentIdentity {
    let identity: SourceContentIdentity;
    try {
      identity = this.resolve(filePath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("source_content_identity_requires_file:")) {
        throw new SourceContentIntegrityError("not_regular_file");
      }
      throw new SourceContentIntegrityError("missing_or_unreadable");
    }
    if (identity.sha256 !== expectedSha256) throw new SourceContentIntegrityError("content_changed");
    return identity;
  }
}
