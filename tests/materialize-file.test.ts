import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializeFileSync } from "../runtime/filesystem/materialize-file.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("materializeFileSync", () => {
  it("preserves exact bytes through clone or portable copy fallback", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-file-"));
    tempDirs.push(directory);
    const source = path.join(directory, "source.mp4");
    const destination = path.join(directory, "nested", "final.mp4");
    const bytes = Buffer.alloc(1024 * 1024, 0x5a);
    fs.writeFileSync(source, bytes);

    const method = materializeFileSync(source, destination);

    expect(["clone", "copy"]).toContain(method);
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.statSync(destination).size).toBe(fs.statSync(source).size);
  });

  it("keeps exclusive materialization fail-closed when the destination exists", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-file-"));
    tempDirs.push(directory);
    const source = path.join(directory, "source.mp4");
    const destination = path.join(directory, "final.mp4");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(destination, "existing");

    expect(() => materializeFileSync(source, destination, { exclusive: true }))
      .toThrow();
    expect(fs.readFileSync(destination, "utf8")).toBe("existing");
  });
});
