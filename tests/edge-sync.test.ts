import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

describe("edge-sync Python unit tests", () => {
  it("passes test_sync.py", () => {
    const venvPy = path.resolve(__dirname, "..", "..", "venv", "Scripts", "python.exe");
    const py = process.env.LEGACY_PYTHON ?? (existsSync(venvPy) ? venvPy : "python");
    execFileSync(py, [path.resolve(__dirname, "..", "edge-sync", "test_sync.py")], { stdio: "pipe" });
  });
});
