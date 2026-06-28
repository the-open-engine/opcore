import type { CloneAnalysisRequest, CloneAnalysisResult, GraphProviderStatus } from "@the-open-engine/opcore-contracts";
import { validateCloneAnalysisResult } from "@the-open-engine/opcore-contracts";
import { resolveGraphCoreArtifact } from "@the-open-engine/opcore-graph";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cloneAnalysisTimeoutMs = 30_000;

export function invokeCloneAnalysis(request: CloneAnalysisRequest): CloneAnalysisResult {
  const resolution = resolveGraphCoreArtifact();
  if (!resolution.ok) {
    throw new Error(`clone native artifact unavailable: ${graphProviderStatusMessage(resolution.status)}`);
  }
  const result = spawnCloneAnalysis(resolution.artifact.executablePath, JSON.stringify(request));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    throw new Error(`clone native analysis failed: ${detail}`);
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) throw new Error("clone native analysis produced no stdout");
  return validateCloneAnalysisResult(JSON.parse(stdout));
}

function spawnCloneAnalysis(
  executablePath: string,
  input: string
): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "opcore-clone-analysis-"));
  const stdoutPath = join(tempDir, "stdout.json");
  const stderrPath = join(tempDir, "stderr.log");
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(stdoutPath, "w+");
    stderrFd = openSync(stderrPath, "w+");
    const result = spawnSync(executablePath, ["clone"], {
      input,
      encoding: "utf8",
      timeout: cloneAnalysisTimeoutMs,
      stdio: ["pipe", stdoutFd, stderrFd]
    });
    closeSync(stdoutFd);
    stdoutFd = undefined;
    closeSync(stderrFd);
    stderrFd = undefined;
    return {
      ...result,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8")
    };
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function graphProviderStatusMessage(status: GraphProviderStatus): string {
  if ("failure" in status && status.failure !== undefined) return status.failure.message;
  return status.state;
}
