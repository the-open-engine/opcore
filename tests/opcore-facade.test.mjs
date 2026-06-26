import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpcoreMetricReport,
  writeOpcoreMetricArtifacts
} from "../packages/opcore/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const opcoreBin = resolve(repoRoot, "packages/opcore/dist/index.js");
const sourceFixtureRoot = resolve(repoRoot, "packages/fixtures/source-extraction/wave1");

describe("opcore public facade", () => {
  it("runs zero-command scan with coverage-first output and only .opcore artifacts", () => {
    withFixtureCopy((fixtureRoot) => {
      const before = collectRepoPaths(fixtureRoot);
      const human = runOpcore([], fixtureRoot, 0);

      assert.equal(human.stderr, "");
      assert.equal(firstNonEmptyLine(human.stdout).startsWith("Coverage"), true);
      assert.equal(human.stdout.indexOf("Coverage") < human.stdout.indexOf("Findings"), true);
      assert.doesNotMatch(human.stdout, /\blattice\b|\bcrg\b|\bcix\b|\brox\b|ASP setup|ACE setup|sibling checkout/i);
      assert.equal(existsSync(join(fixtureRoot, ".opcore", "report.json")), true);
      assert.equal(existsSync(join(fixtureRoot, ".opcore", "history.jsonl")), true);
      assert.deepEqual(readdirSync(join(fixtureRoot, ".opcore")).sort(), ["history.jsonl", "report.json"]);
      assert.equal(existsSync(join(fixtureRoot, ".lattice")), false);
      assert.equal(existsSync(join(fixtureRoot, ".ace")), false);
      assert.equal(existsSync(join(fixtureRoot, ".asp")), false);
      assert.deepEqual(
        collectRepoPaths(fixtureRoot).filter((path) => !before.includes(path) && path !== ".opcore" && !path.startsWith(".opcore/")),
        []
      );

      const json = parseJson(runOpcore(["--json"], fixtureRoot, 0).stdout);
      assert.deepEqual(json.canonicalCommand, ["opcore", "scan"]);
      assert.equal(json.owner, "runtime");
      assert.equal(json.repoState.repo.root, realpathSync(fixtureRoot));
      assert.equal(Object.hasOwn(json, "validationResult"), true);
      assert.equal(json.validationResult.graphStatus.mode, json.repoState.graph.state === "available" ? "required" : "optional");

      const report = JSON.parse(readFileSync(join(fixtureRoot, ".opcore", "report.json"), "utf8"));
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.kind, "opcore_metric_report");
      assert.equal(report.repo.root, realpathSync(fixtureRoot));
      assert.equal(Array.isArray(report.signals), true);
      assert.equal(Array.isArray(report.degradations), true);
      assert.equal(readFileSync(join(fixtureRoot, ".opcore", "history.jsonl"), "utf8").trim().split(/\r?\n/).length >= 2, true);
    });
  });

  it("returns repoState-only status JSON", () => {
    withFixtureCopy((fixtureRoot) => {
      const result = parseJson(runOpcore(["status", "--repo", fixtureRoot, "--json"], fixtureRoot, 0).stdout);

      assert.deepEqual(result.canonicalCommand, ["opcore", "status"]);
      assert.equal(result.status, "ok");
      assert.equal(Object.hasOwn(result, "repoState"), true);
      assert.equal(Object.hasOwn(result, "validationResult"), false);
      assert.equal(Object.hasOwn(result, "validationStatus"), false);
    });
  });

  it("reports Python sources as extraction-pending without graph or validation support", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-python-status-"));
    try {
      for (const [directory, file] of [
        ["", "app.py"],
        ["types", "typings.pyi"],
        [".venv/lib/python3.12/site-packages/pkg", "ignored.py"],
        ["venv/lib/python3.12/site-packages/pkg", "ignored.py"],
        ["env/lib/python3.12/site-packages/pkg", "ignored.py"],
        ["src/__pycache__", "ignored.py"],
        [".eggs/pkg", "ignored.py"],
        ["build/lib", "ignored.py"],
        [".tox/py", "ignored.py"],
        [".mypy_cache", "ignored.py"],
        [".pytest_cache", "ignored.py"],
        [".ruff_cache", "ignored.py"],
        ["pkg.egg-info", "ignored.py"],
        ["pkg.dist-info", "ignored.py"],
        ["lib/site-packages/pkg", "ignored.py"]
      ]) {
        mkdirSync(join(temp, directory), { recursive: true });
        writeFileSync(join(temp, directory, file), "def value():\n    return True\n");
      }

      const result = parseJson(runOpcore(["status", "--repo", temp, "--json"], temp, 0).stdout);
      const coverage = result.repoState.coverage;

      assert.equal(coverage.totalFiles, 2);
      assert.deepEqual(coverage.languages, [
        { language: "Python", files: 2, graphSupported: false, validationSupported: false }
      ]);
      assert.equal(coverage.graph.supportedFiles, 0);
      assert.equal(coverage.validation.supportedFiles, 0);
      assert.equal(coverage.unsupported.totalFiles, 2);
      assert.deepEqual(
        coverage.unsupported.stacks.map((stack) => ({
          extension: stack.extension,
          language: stack.language,
          count: stack.count
        })),
        [
          { extension: ".py", language: "Python", count: 1 },
          { extension: ".pyi", language: "Python", count: 1 }
        ]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs check --changed with default HEAD base and stable agent exit codes", () => {
    withFixtureCopy((fixtureRoot) => {
      initGitFixture(fixtureRoot);
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(a, b) { return a + b + 1; }\n");

      const result = parseJson(
        runOpcore(["check", "--changed", "--checks", "typescript.syntax", "--json"], fixtureRoot, 0).stdout
      );

      assert.deepEqual(result.canonicalCommand, ["opcore", "check", "changed", "--base", "HEAD", "--checks", "typescript.syntax"]);
      assert.equal(result.owner, "validation");
      assert.equal(result.validationResult.ok, true);
      assert.equal(result.validationResult.status, "passed");
      assert.equal(result.validationResult.manifest.runs[0].checkId, "typescript.syntax");
    });
  });

  it("runs check --changed with an explicit base ref", () => {
    withFixtureCopy((fixtureRoot) => {
      initGitFixture(fixtureRoot);
      writeFileSync(join(fixtureRoot, "src/math.js"), "export function add(a, b) { return a + b + 2; }\n");

      const result = parseJson(
        runOpcore(["check", "--changed", "--base", "HEAD", "--checks", "typescript.syntax", "--json"], fixtureRoot, 0).stdout
      );

      assert.deepEqual(result.canonicalCommand, ["opcore", "check", "changed", "--base", "HEAD", "--checks", "typescript.syntax"]);
      assert.equal(result.owner, "validation");
      assert.equal(result.validationResult.ok, true);
      assert.equal(result.validationResult.status, "passed");
      assert.equal(result.validationResult.manifest.runs[0].checkId, "typescript.syntax");
    });
  });

  it("returns measure deltas from .opcore artifacts without running validation", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-measure-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");
      writeOpcoreMetricArtifacts(temp, metricReport(temp, "2026-06-24T00:00:00.000Z", 2));
      writeOpcoreMetricArtifacts(temp, metricReport(temp, "2026-06-25T00:00:00.000Z", 1));
      const historyBefore = readFileSync(join(temp, ".opcore/history.jsonl"), "utf8");
      const reportBefore = readFileSync(join(temp, ".opcore/report.json"), "utf8");

      const measure = parseJson(runOpcore(["measure", "--repo", temp, "--json"], temp, 0).stdout);

      assert.equal(measure.status, "ok");
      assert.deepEqual(measure.canonicalCommand, ["opcore", "measure"]);
      assert.equal(measure.opcoreMeasure.kind, "opcore_measure_delta");
      assert.equal(measure.opcoreMeasure.baseline.deltas.find((entry) => entry.id === "typescript.type_errors").delta, -1);
      assert.equal(Object.hasOwn(measure, "validationResult"), false);
      assert.equal(Object.hasOwn(measure, "validationStatus"), false);
      assert.equal(Object.hasOwn(measure, "repoState"), false);
      assert.equal(readFileSync(join(temp, ".opcore/history.jsonl"), "utf8"), historyBefore);
      assert.equal(readFileSync(join(temp, ".opcore/report.json"), "utf8"), reportBefore);

      const human = runOpcore(["measure", "--repo", temp], temp, 0);
      assert.equal(human.message, undefined);
      assert.equal(human.stdout.indexOf("Coverage:"), 0);
      assert.match(human.stdout, /baseline=-1/);
      assert.doesNotMatch(human.stdout, /0-100|score/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("plans init without writing repo guidance or config", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-plan-"));
    try {
      const result = parseJson(runOpcore(["init", "--repo", temp, "--json"], temp, 0).stdout);

      assert.deepEqual(result.canonicalCommand, ["opcore", "init"]);
      assert.equal(result.status, "ok");
      assert.equal(result.opcoreInit.mode, "plan");
      assert.equal(result.opcoreInit.approved, false);
      assert.equal(result.opcoreInit.actions.some((action) => action.path === ".opcore/config"), true);
      assert.match(result.message, /^opcore init plan/);
      assert.equal(existsSync(join(temp, ".opcore")), false);
      assert.equal(existsSync(join(temp, "AGENTS.md")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies approved init with config and guidance but no default hook", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-apply-"));
    try {
      const result = parseJson(runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0).stdout);

      assert.equal(result.opcoreInit.mode, "apply");
      assert.equal(result.opcoreInit.approved, true);
      assert.equal(result.opcoreInit.undoAvailable, true);
      assert.equal(result.opcoreInit.nextActions.some((action) => action.includes("--undo --approve")), true);
      assert.equal(result.opcoreInit.nextActions.some((action) => action.includes("opcore init --approve")), false);
      assert.equal(existsSync(join(temp, ".opcore", "config")), true);
      assert.equal(existsSync(join(temp, ".opcore", "init-undo.json")), true);
      assert.equal(existsSync(join(temp, ".opcore", "hooks", "pre-commit-opcore-check.sh")), false);
      const config = JSON.parse(readFileSync(join(temp, ".opcore", "config"), "utf8"));
      assert.equal(config.schemaVersion, 1);
      assert.equal(config.guidance.checkCommand, "opcore check --changed");
      const agents = readFileSync(join(temp, "AGENTS.md"), "utf8");
      assert.equal(markerCount(agents), 1);
      assert.match(agents, /opcore check --changed/);
      assert.match(agents, /preserve existing repo lint\/test\/CI\/pre-commit guardrails/i);
      assert.match(agents, /unsupported stacks and degraded tools/i);
      assert.match(agents, /Do not rely on ACE, Rox, CRG, CIX, or ASP host authority/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("updates init guidance idempotently and preserves existing AGENTS content", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-idempotent-"));
    try {
      writeFileSync(join(temp, "AGENTS.md"), "keep-before\n");
      runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0);
      runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0);

      const agents = readFileSync(join(temp, "AGENTS.md"), "utf8");
      assert.match(agents, /^keep-before/m);
      assert.equal(markerCount(agents), 1);
      assert.equal(endMarkerCount(agents), 1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("mirrors init guidance to existing CLAUDE.md and never creates CLAUDE.md when absent", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-claude-"));
    const tempWithoutClaude = mkdtempSync(join(tmpdir(), "opcore-init-no-claude-"));
    try {
      writeFileSync(join(temp, "CLAUDE.md"), "claude-before\n");
      runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0);

      const claude = readFileSync(join(temp, "CLAUDE.md"), "utf8");
      assert.match(claude, /^claude-before/m);
      assert.equal(markerCount(claude), 1);

      runOpcore(["init", "--repo", tempWithoutClaude, "--approve", "--json"], tempWithoutClaude, 0);
      assert.equal(existsSync(join(tempWithoutClaude, "AGENTS.md")), true);
      assert.equal(existsSync(join(tempWithoutClaude, "CLAUDE.md")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(tempWithoutClaude, { recursive: true, force: true });
    }
  });

  it("writes fail-closed hook only when explicitly requested and approved", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-hook-"));
    try {
      runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0);
      assert.equal(existsSync(join(temp, ".opcore", "hooks", "pre-commit-opcore-check.sh")), false);

      const result = parseJson(
        runOpcore(["init", "--repo", temp, "--approve", "--fail-closed-hook", "--json"], temp, 0).stdout
      );
      const hook = readFileSync(join(temp, ".opcore", "hooks", "pre-commit-opcore-check.sh"), "utf8");
      assert.equal(result.opcoreInit.options.failClosedHook, true);
      assert.match(hook, /opcore check --changed/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("undoes init by restoring previous files and removing init-created files", () => {
    const withExistingAgents = mkdtempSync(join(tmpdir(), "opcore-init-undo-existing-"));
    const withoutAgents = mkdtempSync(join(tmpdir(), "opcore-init-undo-created-"));
    try {
      writeFileSync(join(withExistingAgents, "AGENTS.md"), "original agents\n");
      runOpcore(["init", "--repo", withExistingAgents, "--approve", "--json"], withExistingAgents, 0);
      runOpcore(["init", "--repo", withExistingAgents, "--approve", "--json"], withExistingAgents, 0);
      const undoPlan = parseJson(runOpcore(["init", "--repo", withExistingAgents, "--undo", "--json"], withExistingAgents, 0).stdout);
      assert.equal(undoPlan.opcoreInit.mode, "undo");
      assert.equal(undoPlan.opcoreInit.approved, false);
      runOpcore(["init", "--repo", withExistingAgents, "--undo", "--approve", "--json"], withExistingAgents, 0);
      assert.equal(readFileSync(join(withExistingAgents, "AGENTS.md"), "utf8"), "original agents\n");

      runOpcore(["init", "--repo", withoutAgents, "--approve", "--json"], withoutAgents, 0);
      runOpcore(["init", "--repo", withoutAgents, "--approve", "--json"], withoutAgents, 0);
      const undoResult = parseJson(runOpcore(["init", "--repo", withoutAgents, "--undo", "--approve", "--json"], withoutAgents, 0).stdout);
      assert.equal(undoResult.opcoreInit.undoAvailable, false);
      assert.equal(undoResult.opcoreInit.nextActions.some((action) => action.includes("rerun opcore init")), true);
      assert.equal(undoResult.opcoreInit.nextActions.some((action) => action.includes("--undo --approve")), false);
      assert.equal(existsSync(join(withoutAgents, "AGENTS.md")), false);
      assert.equal(existsSync(join(withoutAgents, ".opcore", "config")), false);
    } finally {
      rmSync(withExistingAgents, { recursive: true, force: true });
      rmSync(withoutAgents, { recursive: true, force: true });
    }
  });

  it("refuses undo metadata that targets source files", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-undo-source-target-"));
    try {
      mkdirSync(join(temp, ".opcore"), { recursive: true });
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src", "app.ts"), "export const safe = true;\n");
      writeFileSync(
        join(temp, ".opcore", "init-undo.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "opcore_init_undo",
          repoRoot: realpathSync(temp),
          entries: [{ path: "src/app.ts", existed: false }]
        })}\n`
      );

      const result = parseJson(runOpcore(["init", "--repo", temp, "--undo", "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /unsupported path/i);
      assert.equal(readFileSync(join(temp, "src", "app.ts"), "utf8"), "export const safe = true;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses undo metadata for a different repo root", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-undo-wrong-root-"));
    const other = mkdtempSync(join(tmpdir(), "opcore-init-undo-other-root-"));
    try {
      mkdirSync(join(temp, ".opcore"), { recursive: true });
      writeFileSync(join(temp, "AGENTS.md"), "current agents\n");
      writeFileSync(
        join(temp, ".opcore", "init-undo.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "opcore_init_undo",
          repoRoot: other,
          entries: [{ path: "AGENTS.md", existed: false }]
        })}\n`
      );

      const result = parseJson(runOpcore(["init", "--repo", temp, "--undo", "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /repoRoot/i);
      assert.equal(readFileSync(join(temp, "AGENTS.md"), "utf8"), "current agents\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses undo metadata with non-string restore content", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-undo-invalid-content-"));
    try {
      mkdirSync(join(temp, ".opcore"), { recursive: true });
      writeFileSync(join(temp, "AGENTS.md"), "current agents\n");
      writeFileSync(
        join(temp, ".opcore", "init-undo.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "opcore_init_undo",
          repoRoot: realpathSync(temp),
          entries: [{ path: "AGENTS.md", existed: true, content: 42 }]
        })}\n`
      );

      const result = parseJson(runOpcore(["init", "--repo", temp, "--undo", "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /string content/i);
      assert.equal(readFileSync(join(temp, "AGENTS.md"), "utf8"), "current agents\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses approved init when an existing agent file symlink resolves outside the repo", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-agent-symlink-"));
    const outside = join(mkdtempSync(join(tmpdir(), "opcore-init-agent-outside-")), "outside.md");
    try {
      writeFileSync(outside, "secret-outside\n");
      symlinkSync(outside, join(temp, "AGENTS.md"));

      const result = parseJson(runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink|outside repository/i);
      assert.equal(readFileSync(outside, "utf8"), "secret-outside\n");
      assert.equal(existsSync(join(temp, ".opcore", "init-undo.json")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(dirname(outside), { recursive: true, force: true });
    }
  });

  it("refuses approved init when an existing agent file is a repo-local symlink", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-agent-local-symlink-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src", "app.ts"), "export const x = 1;\n");
      symlinkSync("src/app.ts", join(temp, "AGENTS.md"));

      const result = parseJson(runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink/i);
      assert.equal(readFileSync(join(temp, "src", "app.ts"), "utf8"), "export const x = 1;\n");
      assert.equal(existsSync(join(temp, ".opcore", "init-undo.json")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses approved init when a write parent symlink resolves outside the repo", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-parent-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "opcore-init-parent-outside-"));
    try {
      symlinkSync(outside, join(temp, ".opcore"), "dir");

      const result = parseJson(runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink|outside repository/i);
      assert.deepEqual(readdirSync(outside), []);
      assert.equal(existsSync(join(temp, "AGENTS.md")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses approved init when the .opcore parent is a repo-local symlink", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-local-parent-symlink-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      symlinkSync("src", join(temp, ".opcore"), "dir");

      const result = parseJson(runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink/i);
      assert.deepEqual(readdirSync(join(temp, "src")), []);
      assert.equal(existsSync(join(temp, "AGENTS.md")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses approved fail-closed hook when the hook parent is a repo-local symlink", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-hook-parent-symlink-"));
    try {
      mkdirSync(join(temp, ".opcore"), { recursive: true });
      mkdirSync(join(temp, "src"), { recursive: true });
      symlinkSync("../src", join(temp, ".opcore", "hooks"), "dir");

      const result = parseJson(
        runOpcore(["init", "--repo", temp, "--approve", "--fail-closed-hook", "--json"], temp, 1).stdout
      );

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink/i);
      assert.deepEqual(readdirSync(join(temp, "src")), []);
      assert.equal(existsSync(join(temp, "AGENTS.md")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses undo restore when a recorded target symlink resolves outside the repo", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-undo-symlink-"));
    const outside = join(mkdtempSync(join(tmpdir(), "opcore-init-undo-outside-")), "outside.md");
    try {
      writeFileSync(join(temp, "AGENTS.md"), "original agents\n");
      writeFileSync(outside, "secret-outside\n");
      runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0);
      rmSync(join(temp, "AGENTS.md"), { force: true });
      symlinkSync(outside, join(temp, "AGENTS.md"));

      const result = parseJson(runOpcore(["init", "--repo", temp, "--undo", "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink|outside repository/i);
      assert.equal(readFileSync(outside, "utf8"), "secret-outside\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(dirname(outside), { recursive: true, force: true });
    }
  });

  it("refuses undo restore when a recorded target is a repo-local symlink", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-init-undo-local-symlink-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "AGENTS.md"), "original agents\n");
      writeFileSync(join(temp, "src", "app.ts"), "export const x = 1;\n");
      runOpcore(["init", "--repo", temp, "--approve", "--json"], temp, 0);
      rmSync(join(temp, "AGENTS.md"), { force: true });
      symlinkSync("src/app.ts", join(temp, "AGENTS.md"));

      const result = parseJson(runOpcore(["init", "--repo", temp, "--undo", "--approve", "--json"], temp, 1).stdout);

      assert.equal(result.status, "error");
      assert.match(result.message, /symlink/i);
      assert.equal(readFileSync(join(temp, "src", "app.ts"), "utf8"), "export const x = 1;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns explicit measure errors and unsupported-command exits", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-commands-"));
    try {
      const measure = parseJson(runOpcore(["measure", "--json"], temp, 1).stdout);
      assert.equal(measure.status, "error");
      assert.deepEqual(measure.canonicalCommand, ["opcore", "measure"]);
      assert.match(measure.message, /\.opcore\/report\.json/);

      const unknown = parseJson(runOpcore(["unknown", "--json"], temp, 64).stdout);
      assert.equal(unknown.status, "unsupported");
      assert.deepEqual(unknown.canonicalCommand, ["opcore", "unknown"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs try with generated sample repos, coverage-first output, and no launch-forbidden claims", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-try-cwd-"));
    const cleanupRoots = [];
    try {
      const jsonResult = parseJson(runOpcore(["try", "--json"], temp, 0).stdout);
      cleanupRoots.push(jsonResult.opcoreTry.sampleRoot);
      assert.deepEqual(jsonResult.canonicalCommand, ["opcore", "try"]);
      assert.equal(jsonResult.owner, "runtime");
      assert.equal(jsonResult.opcoreTry.published, false);
      assert.deepEqual(
        jsonResult.opcoreTry.scenarios.map((scenario) => scenario.id).sort(),
        ["mixed-repo", "rust-crate", "typescript-app", "unsupported-files"]
      );
      const signalIds = new Set(jsonResult.opcoreTry.scenarios.flatMap((scenario) => scenario.signals.map((signal) => signal.id)));
      assert.equal(signalIds.has("typescript.type_errors"), true);
      assert.equal(signalIds.has("rust.source_hygiene"), true);
      assert.equal(signalIds.has("coverage.unsupported_stacks"), true);
      assert.equal(jsonResult.opcoreTry.commands.some((command) => command.canonicalCommand.join(" ") === "opcore measure"), true);

      const human = runOpcore(["try"], temp, 0).stdout;
      const sandbox = human.match(/Sandbox:\n  ([^\n]+)/)?.[1];
      if (sandbox) cleanupRoots.push(sandbox);
      assert.equal(firstNonEmptyLine(human), "Coverage:");
      assert.match(human, /Findings:\n(?:.*\n)*  typescript\.type_errors:/);
      assert.match(human, /rust\.source_hygiene:/);
      assert.match(human, /coverage\.unsupported_stacks:/);
      assert.doesNotMatch(human, /score|SAST|security scanner|AI authorship|Rox|CRG|CIX|ACE/i);
    } finally {
      for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps launch help on Opcore naming only", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-help-"));
    try {
      const help = runOpcore(["--help"], temp, 0);
      assert.equal(help.stderr, "");
      assert.match(help.stdout, /^Opcore\b/);
      assert.match(help.stdout, /opcore check --changed --json/);
      assert.doesNotMatch(help.stdout, /\blattice\b|\bcrg\b|\bcix\b|\brox\b/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function withFixtureCopy(runFixture) {
  const temp = mkdtempSync(join(tmpdir(), "opcore-facade-"));
  const fixtureRoot = join(temp, "repo");
  try {
    cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true });
    runFixture(fixtureRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function initGitFixture(repo) {
  run("git", ["init"], repo, 0);
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = run("git", ["commit-tree", emptyTree, "-m", "fixture"], repo, 0, {
    ...process.env,
    GIT_AUTHOR_NAME: "Opcore Test",
    GIT_AUTHOR_EMAIL: "opcore@example.invalid",
    GIT_COMMITTER_NAME: "Opcore Test",
    GIT_COMMITTER_EMAIL: "opcore@example.invalid"
  }).stdout.trim();
  run("git", ["branch", "-f", "main", commit], repo, 0);
  run("git", ["checkout", "-q", "main"], repo, 0);
}

function runOpcore(args, cwd, expectedStatus) {
  return run(process.execPath, [opcoreBin, ...args], cwd, expectedStatus);
}

function run(command, args, cwd, expectedStatus, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, npm_lifecycle_event: undefined },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, expectedStatus, [
    `Command: ${command} ${args.join(" ")}`,
    `cwd: ${cwd}`,
    `status: ${result.status}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join("\n"));
  return result;
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function firstNonEmptyLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
}

function collectRepoPaths(root) {
  const paths = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      paths.push(path);
      if (entry.isDirectory()) stack.push(absolute);
    }
  }
  return paths.sort();
}

function markerCount(text) {
  return (text.match(/BEGIN OPCORE INIT/g) ?? []).length;
}

function endMarkerCount(text) {
  return (text.match(/END OPCORE INIT/g) ?? []).length;
}

function metricReport(repoRoot, generatedAt, typeErrorCount) {
  return createOpcoreMetricReport({
    repoState: metricRepoState(repoRoot),
    validationResult: {
      ok: typeErrorCount === 0,
      status: typeErrorCount === 0 ? "passed" : "policy_failure",
      diagnostics: Array.from({ length: typeErrorCount }, (_, index) => ({
        category: "types",
        severity: "error",
        path: `src/index-${index}.ts`,
        code: "TS2322",
        message: "Type mismatch"
      })),
      manifest: {
        schemaVersion: 1,
        checks: ["typescript.types"],
        generatedAt
      }
    },
    graphFacts: { nodes: [], edges: [] },
    generatedAt
  });
}

function metricRepoState(repoRoot) {
  const root = realpathSync(repoRoot);
  return {
    schemaVersion: 1,
    repo: {
      root,
      requestedPath: root,
      git: {
        available: false
      }
    },
    coverage: {
      totalFiles: 1,
      languages: [{ language: "TypeScript", files: 1, graphSupported: true, validationSupported: true }],
      graph: {
        supportedFiles: 1,
        extensions: [{ extension: ".ts", count: 1 }]
      },
      validation: {
        supportedFiles: 1,
        retainedFiles: 0,
        extensions: [{ extension: ".ts", count: 1 }]
      },
      unsupported: {
        totalFiles: 0,
        stacks: []
      }
    },
    graph: {
      state: "skipped",
      mode: "optional",
      provider: "lattice-graph",
      action: "build the graph with lattice graph build.",
      status: {
        state: "skipped",
        mode: "optional",
        provider: "lattice-graph",
        schemaVersion: 1,
        failure: {
          category: "provider_missing",
          message: "Graph missing"
        }
      }
    },
    validation: {
      ready: true,
      checkCount: 15,
      adapters: [],
      degradedToolchains: []
    },
    activation: {
      ready: false,
      level: "degraded",
      summary: "Repo is degraded.",
      asp: {
        state: "not_enrolled",
        paths: []
      }
    },
    warnings: [],
    blockers: [],
    nextActions: [`lattice graph build --repo ${root} --json`]
  };
}
