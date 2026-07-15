import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
  releaseCutoverCurrentToolGuardrailIds,
  releaseCutoverNegativeCheckIds,
  releaseCutoverPythonCommandIds,
  releaseCutoverRequiredCommandIds,
  releaseCutoverRustCommandIds,
  releaseReceiptPackageNames
} from "../packages/contracts/dist/index.js";
import { bundledExternalRuntimePackageNames } from "../scripts/release-package-dirs.mjs";
import { externalRuntimePackageDir } from "../scripts/stage-opcore-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDocsLockTimeoutMs = 900000;
const copiedRepoSkips = new Set([
  ".git",
  "node_modules",
  "target",
  ".ace",
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".lattice",
  ".code-review-graph",
  ".rox-cache",
  ".robustness-engine-cache",
  ".receipt-test.lock"
]);

describe("negative gate fixtures", () => {
  it("rejects tracked TypeScript build info", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "packages/contracts/tsconfig.tsbuildinfo"), "{}\n");
    run(repo, "git", ["add", "-f", "packages/contracts/tsconfig.tsbuildinfo"]);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Generated TypeScript build info must not be checked in/);
  });

  it("rejects Python CRG provenance markers", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "pyproject.toml"), "[project]\nname = \"code-review-graph\"\n");
    run(repo, "git", ["add", "pyproject.toml"]);

    const result = run(repo, "node", ["scripts/check-provenance.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Forbidden Python packaging file/);
  });

  it("rejects provenance receipt checks without build artifacts", () => {
    const repo = tempRepo();
    const workflowPath = join(repo, ".github/workflows/provenance.yml");
    const workflow = readFileSync(workflowPath, "utf8")
      .replace(/\n      - name: Setup Rust[\s\S]*?\n      - name: Install/, "\n      - name: Install")
      .replace(/\n      - name: Build release artifacts[\s\S]*?\n      - name: Provenance checks/, "\n      - name: Provenance checks");
    writeFileSync(workflowPath, workflow);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /provenance\.yml.*(build.*release receipt|release-receipt:check.*build)/i);
  });

  it("rejects high-confidence secrets in release receipt scan", () => {
    const repo = tempRepo({ includeDist: true });
    writeFileSync(join(repo, "secret.txt"), `OPENAI_API_KEY=${JSON.stringify(`sk-${"a".repeat(40)}`)}\n`);

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--scan-secrets-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Secret\/history scan.*secret\.txt|openai_api_key/i);
  });

  it("allows reviewed path-scoped secret false positives", () => {
    const repo = tempRepo({ includeDist: true });
    writeFileSync(join(repo, "tmp-allowlisted-secret.txt"), ["token", " = ", JSON.stringify("documented-placeholder-value"), "\n"].join(""));
    writeFileSync(
      join(repo, "docs/release/secret-scan-allowlist.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              scope: "current-tree",
              kind: "credential_assignment",
              path: "tmp-allowlisted-secret.txt",
              reviewer: "validator-code",
              reason: "false positive fixture",
              expiresAt: "2999-01-01"
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--scan-secrets-only", "--json"]);
    const scan = JSON.parse(result.stdout);
    assert.equal(scan.findingCount, 0);
  });

  it("rejects secret allowlist entries without reviewed metadata", () => {
    const repo = tempRepo({ includeDist: true });
    writeFileSync(
      join(repo, "docs/release/secret-scan-allowlist.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              scope: "current-tree",
              path: "tmp-allowlisted-secret.txt"
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--scan-secrets-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /allowlist.*reviewer|allowlist.*reason|allowlist.*expiresAt/i);
  });

  it("rejects secret allowlist entries without path or commit scope", () => {
    const repo = tempRepo({ includeDist: true });
    writeFileSync(
      join(repo, "docs/release/secret-scan-allowlist.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              scope: "current-tree",
              reviewer: "validator-code",
              reason: "missing path fixture",
              expiresAt: "2999-01-01"
            }
          ]
        },
        null,
        2
      )}\n`
    );

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--scan-secrets-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /allowlist.*path|allowlist.*commit/i);
  });

  it("rejects unexpected package files in release package inspection", () => {
    const repo = tempRepo({ includeDist: true });
    const manifestPath = join(repo, "packages/edit/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = [...manifest.files, "EXTRA.md"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(repo, "packages/edit/EXTRA.md"), "unexpected release file\n");

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--inspect-packages-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /packed files mismatch|EXTRA\.md/);
  });

  it("rejects old public bins in release package inspection", () => {
    const repo = tempRepo({ includeDist: true });
    const manifestPath = join(repo, "packages/opcore/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.bin.crg = "dist/index.js";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--inspect-packages-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /forbidden old public bin crg/);
  });

  it("rejects canonical ASP server manifest launch claim overreach", () => {
    const repo = tempRepo({ includeDist: true });
    const manifestPath = join(repo, "packages/asp-provider/dist/manifests/asp-server.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.provenance.source = "ASP is a public standard now with provider authority";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-release-hygiene.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Launch-facing claim scrub failed/);
    assert.match(stderrAndStdout(result), /packages\/asp-provider\/dist\/manifests\/asp-server\.json/);
  });

  it("rejects generic Opcore replacement overclaims in launch docs", () => {
    const repo = tempRepo({ includeDist: true });
    writeFileSync(join(repo, "docs/quickstart.md"), "Opcore replaces your linters.\n");

    const result = run(repo, "node", ["scripts/check-release-hygiene.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Launch-facing claim scrub failed/);
    assert.match(stderrAndStdout(result), /generic Opcore replacement claim/);
    assert.match(stderrAndStdout(result), /docs\/quickstart\.md/);
  });

  it("rejects blended quality score overclaims in launch docs", () => {
    const repo = tempRepo({ includeDist: true });
    writeFileSync(join(repo, "docs/quickstart.md"), "Opcore reports a blended quality score.\n");

    const result = run(repo, "node", ["scripts/check-release-hygiene.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Launch-facing claim scrub failed/);
    assert.match(stderrAndStdout(result), /blended score claim/);
    assert.match(stderrAndStdout(result), /docs\/quickstart\.md/);
  });

  it("rejects bad descriptor artifact references in release descriptor inspection", () => {
    const repo = tempRepo({ includeDist: true });
    const descriptorPath = join(repo, "packages/opcore/dist/descriptors/opcore.managed-tool.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    descriptor.artifacts = descriptor.artifacts.map((artifact) =>
      artifact.id === "descriptor" ? { ...artifact, path: "dist/descriptors/missing.json" } : artifact
    );
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--inspect-descriptor-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /packaged descriptor artifact|missing\.json/);
  });

  it("rejects missing native checksum evidence in release package inspection", () => {
    const repo = tempRepo({ includeDist: true });
    const packageName = graphCoreNativePackageNameForTarget(`${process.platform}-${process.arch}`);
    const checksumPath = join(
      repo,
      "packages",
      packageName.replace("@the-open-engine/", ""),
      "opcore-graph-core.sha256"
    );
    rmSync(checksumPath, { force: true });

    const result = run(repo, "node", ["scripts/generate-release-receipt.mjs", "--inspect-packages-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /packed files mismatch|checksum|sha256/);
  });

  it("rejects current-tool markers in cutover descriptor inspection", () => {
    const repo = tempRepo({ includeDist: true });
    const descriptorPath = join(repo, "packages/opcore/dist/descriptors/opcore.managed-tool.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    descriptor.artifacts[0].path = ".ace/runtime/bin/lattice";
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/generate-cutover-receipt.mjs", "--inspect-descriptor-only"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /private runtime|forbidden marker|\.ace/);
  });

  it("rejects cutover receipts with advertised not_implemented commands", () => {
    const repo = tempRepo({ includeDist: true });
    const receiptPath = join(repo, "bad-cutover-receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(minimalCutoverReceipt(repo, { status: "not_implemented", exitCode: 2 }), null, 2)}\n`);

    const result = run(repo, "node", ["scripts/generate-cutover-receipt.mjs", "--validate-receipt-file", "bad-cutover-receipt.json"], {
      expectFailure: true
    });
    assert.match(stderrAndStdout(result), /not_implemented/);
  });

  it("rejects cutover receipts missing required command evidence", () => {
    const repo = tempRepo({ includeDist: true });
    const receiptPath = join(repo, "bad-cutover-missing-command.json");
    const receipt = minimalCutoverReceipt(repo);
    receipt.commandReceipts = receipt.commandReceipts.filter((entry) => entry.id !== "inspect-search");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/generate-cutover-receipt.mjs", "--validate-receipt-file", "bad-cutover-missing-command.json"], {
      expectFailure: true
    });
    assert.match(stderrAndStdout(result), /command receipts.*inspect-search/);
  });

  it("rejects old bin fallback in installed cutover projects", () => {
    const repo = tempRepo({ includeDist: true });
    const project = join(repo, "tmp-installed-project");
    mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(project, "node_modules/.bin/lattice"), "#!/bin/sh\n");
    writeFileSync(join(project, "node_modules/.bin/opcore"), "#!/bin/sh\n");
    writeFileSync(join(project, "node_modules/.bin/opcore-asp-provider"), "#!/bin/sh\n");
    writeFileSync(join(project, "node_modules/.bin/crg"), "#!/bin/sh\n");

    const result = run(repo, "node", ["scripts/generate-cutover-receipt.mjs", "--inspect-installed-bin-dir", "tmp-installed-project"], {
      expectFailure: true
    });
    assert.match(stderrAndStdout(result), /old public bin.*lattice/);
  });

  it("rejects sibling file dependencies", () => {
    const repo = tempRepo();
    const manifestPath = join(repo, "packages/graph/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@covibes/covibes"] = "file:../../covibes";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /file dependencies must stay inside packages|must not reference sibling repo/);
  });

  it("rejects parent-directory TypeScript outputs", () => {
    const repo = tempRepo();
    const tsconfigPath = join(repo, "packages/validation/tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    tsconfig.compilerOptions.outDir = "../dist";
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /must not reference parent directories or absolute paths/);
  });

  it("rejects reserved graph implementation package paths", () => {
    const repo = tempRepo();
    const readmePath = join(repo, "reserved-graph-name.md");
    writeFileSync(readmePath, `${["packages", "crg"].join("/")} is reserved for removed implementation references\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /reserved graph naming references/);
  });

  it("rejects reserved graph implementation package names", () => {
    const repo = tempRepo();
    const manifestPath = join(repo, "packages/graph/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.description = `Reserved ${`@the-open-engine/opcore-${"crg"}`} implementation name`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /reserved graph naming references/);
  });

  it("rejects reserved graph provider literals", () => {
    const repo = tempRepo();
    const sourcePath = join(repo, "packages/graph/src/reserved-provider.ts");
    writeFileSync(sourcePath, `export const status = { provider: ${JSON.stringify("crg")} };\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /reserved graph naming references/);
  });

  it("rejects reserved graph providerName metadata", () => {
    const repo = tempRepo();
    const sourcePath = join(repo, "packages/graph/src/reserved-provider-name-metadata.ts");
    writeFileSync(sourcePath, `export const status = { providerName: ${JSON.stringify("crg")} };\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /reserved-provider-name-metadata\.ts/);
    assert.match(stderrAndStdout(result), /legacy graph provider name metadata/);
  });

  it("rejects reserved graph provider name constants", () => {
    const repo = tempRepo();
    const sourcePath = join(repo, "packages/graph/src/bad-provider-name.ts");
    const legacyGraphTool = "cr" + "g";
    writeFileSync(sourcePath, `export const crgProviderName = ${JSON.stringify(legacyGraphTool)};\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /bad-provider-name\.ts/);
    assert.match(stderrAndStdout(result), /legacy graph provider name constant/);
  });

  it("rejects stale CONTRIBUTING graph naming", () => {
    const repo = tempRepo();
    const contributingPath = join(repo, "CONTRIBUTING.md");
    const legacyGraphTool = "cr" + "g";
    const content = readFileSync(contributingPath, "utf8")
      .replace(
        "Opcore is a public alpha for local code intelligence, edit planning, and pre-write validation for coding agents.",
        `Opcore is a public alpha code-intelligence monorepo for \`${legacyGraphTool}\`, edit, and validation.`
      )
      .replace(
        "Graph extraction, persistence, query, search, and impact belong in `@the-open-engine/opcore-graph`.",
        `Graph extraction, persistence, query, search, and impact graph production belongs in \`${legacyGraphTool}\`.`
      );
    writeFileSync(contributingPath, content);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /CONTRIBUTING\.md/);
    assert.match(stderrAndStdout(result), /reserved graph naming references/);
  });

  it("rejects edit importing graph-core native artifact loaders", () => {
    const repo = tempRepo();
    const sourcePath = join(repo, "packages/edit/src/bad-graph-loader.ts");
    writeFileSync(sourcePath, `import { resolveGraphCoreArtifact } from "@the-open-engine/opcore-graph";\nvoid resolveGraphCoreArtifact;\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /bad-graph-loader\.ts/);
  });

  it("rejects validation relying on graph sqlite internals", () => {
    const repo = tempRepo();
    const sourcePath = join(repo, "packages/validation/src/bad-graph-sqlite.ts");
    writeFileSync(sourcePath, `export const graphSqliteInternal = "graph sqlite internal reader";\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /bad-graph-sqlite\.ts/);
  });

  it("rejects Cargo package names containing crg", () => {
    const repo = tempRepo();
    const manifestPath = join(repo, "crates/graph-core/Cargo.toml");
    const manifest = readFileSync(manifestPath, "utf8").replace(
      'name = "opcore-graph-core"',
      `name = "lattice-${"crg"}-core"`
    );
    writeFileSync(manifestPath, manifest);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /must not use crg in Rust package/);
  });

  it("rejects Rox code-quality coverage without all Rust crate paths", () => {
    const repo = tempRepo();
    const roxPath = join(repo, "rox.json");
    const rox = JSON.parse(readFileSync(roxPath, "utf8"));
    rox.checks.codeQuality.include = rox.checks.codeQuality.include.filter((entry) => entry !== "crates/");
    writeFileSync(roxPath, `${JSON.stringify(rox, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /checks\.codeQuality\.include must include "crates\/"/);
  });

  it("rejects Rox code-quality coverage without existing TypeScript and script scopes", () => {
    const repo = tempRepo();
    const roxPath = join(repo, "rox.json");
    const rox = JSON.parse(readFileSync(roxPath, "utf8"));
    rox.checks.codeQuality.include = ["crates/"];
    writeFileSync(roxPath, `${JSON.stringify(rox, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /checks\.codeQuality\.include must include "packages\/"/);
  });

  it("rejects scoped Rust quality scripts that run against the whole repo", () => {
    const repo = tempRepo();
    const manifestPath = join(repo, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts["current-tools:validate-rust-graph"] = "./.ace/runtime/bin/rox check --all --no-daemon --checks functionMetrics";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /must run scoped Rust graph function metrics script/);
  });

  it("rejects repo-wide Rox without scoped Rust graph metrics", () => {
    const repo = tempRepo();
    const roxPath = join(repo, "rox.json");
    const rox = JSON.parse(readFileSync(roxPath, "utf8"));
    rox.extensions = rox.extensions.filter((entry) => entry !== "scripts/check-rust-graph-function-metrics.mjs");
    writeFileSync(roxPath, `${JSON.stringify(rox, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /must run scoped Rust graph function metrics/);
  });

  it("rejects Rox all-mode Rust metrics without crate package scope", () => {
    const repo = tempRepo();
    const roxPath = join(repo, "rox.json");
    const rox = JSON.parse(readFileSync(roxPath, "utf8"));
    rox.packages = rox.packages.filter((entry) => entry !== "crates");
    writeFileSync(roxPath, `${JSON.stringify(rox, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /packages must include "crates"/);
  });

  it("rejects Rox code-quality coverage without changed-file modes", () => {
    const repo = tempRepo();
    const roxPath = join(repo, "rox.json");
    const rox = JSON.parse(readFileSync(roxPath, "utf8"));
    rox.checks.codeQuality.when.modes = rox.checks.codeQuality.when.modes.filter((entry) => entry !== "changed");
    writeFileSync(roxPath, `${JSON.stringify(rox, null, 2)}\n`);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /checks\.codeQuality\.when\.modes must include "changed"/);
  });

  it("rejects graph-core crates without workspace lint opt-in", () => {
    const repo = tempRepo();
    const manifestPath = join(repo, "crates/graph-core/Cargo.toml");
    const manifest = readFileSync(manifestPath, "utf8").replace(/\n\[lints]\nworkspace = true\n?/, "\n");
    writeFileSync(manifestPath, manifest);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /crates\/graph-core\/Cargo\.toml must include \[lints]/);
  });

  it("rejects Cargo workspace manifests without clippy lint policy", () => {
    const repo = tempRepo();
    const manifestPath = join(repo, "Cargo.toml");
    const manifest = readFileSync(manifestPath, "utf8").replace(/\n\[workspace\.lints\.clippy][\s\S]*$/, "\n");
    writeFileSync(manifestPath, manifest);

    const result = run(repo, "node", ["scripts/check-workspace.mjs"], { expectFailure: true });
    assert.match(stderrAndStdout(result), /Cargo\.toml must include \[workspace\.lints\.clippy]/);
  });
});

function tempRepo(options = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "lattice-gate-"));
  const repo = join(tempRoot, "repo");
  withReleaseDocsLock(() => {
    cpSync(repoRoot, repo, {
      recursive: true,
      filter(source) {
        const rel = relative(repoRoot, source);
        if (rel === "") return true;
        return !rel.split(/[\\/]/).some((segment) => copiedRepoSkips.has(segment) || (segment === "dist" && !options.includeDist));
      }
    });
  });
  if (options.includeDist) copyBundledExternalRuntimePackages(repo);
  run(repo, "git", ["init", "--quiet"]);
  stageRepoEntries(repo);
  return repo;
}

function copyBundledExternalRuntimePackages(repo) {
  for (const packageName of bundledExternalRuntimePackageNames) {
    const source = externalRuntimePackageDir(packageName);
    const destination = join(repo, "node_modules", ...packageName.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function stageRepoEntries(repo) {
  const files = run(repo, "git", ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
  for (let index = 0; index < files.length; index += 100) {
    run(repo, "git", ["add", "--", ...files.slice(index, index + 100)]);
  }
}

function withReleaseDocsLock(runLocked) {
  const lockPath = join(repoRoot, "docs/release/.receipt-test.lock");
  const deadline = Date.now() + releaseDocsLockTimeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      try {
        return runLocked();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      sleep(50);
    }
  }
  throw new Error(`timed out waiting for ${lockPath}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} should fail`);
    return result;
  }
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${stderrAndStdout(result)}`);
  return result;
}

function stderrAndStdout(result) {
  return `${result.stderr}\n${result.stdout}`;
}

function minimalCutoverReceipt(repo, commandOverrides = {}) {
  const packageNames = releaseReceiptPackageNames;
  const descriptor = JSON.parse(readFileSync(join(repo, "packages/fixtures/descriptors/opcore.managed-tool.json"), "utf8"));
  const commandReceipts = cutoverCommandExpectations().map((expectation) => ({
    id: expectation.id,
    command: expectation.command,
    canonicalCommand: expectation.command,
    owner: expectation.owner,
    status: expectation.status,
    exitCode: expectation.exitCode,
    binPath: `node_modules/.bin/${expectation.command[0]}`,
    stdoutSha256: "1".repeat(64),
    stderrSha256: "2".repeat(64),
    assertion: `${expectation.id} passed`,
    ...commandOverrides
  }));
  assert.deepEqual(
    commandReceipts.map((entry) => entry.id),
    releaseCutoverRequiredCommandIds
  );
  const rustCommandReceipts = cutoverRustCommandExpectations().map((expectation) => commandReceipt(expectation, "opcore", "passed on Rust fixture"));
  assert.deepEqual(
    rustCommandReceipts.map((entry) => entry.id),
    releaseCutoverRustCommandIds
  );
  const pythonCommandReceipts = cutoverPythonCommandExpectations().map((expectation) => commandReceipt(expectation, expectation.command[0], "passed on Python fixture"));
  assert.deepEqual(
    pythonCommandReceipts.map((entry) => entry.id),
    releaseCutoverPythonCommandIds
  );
  const negativeChecks = [
    {
      id: "missing-required-graph-check",
      command: ["opcore", "check", "files", "src/index.ts", "--repo", "<missing-graph-repo>", "--graph-mode", "required", "--checks", "typescript.import-graph"],
      status: "passed",
      exitCode: 0,
      assertion: "typed provider failure"
    },
    {
      id: "missing-required-graph-validate",
      command: ["opcore", "validate", "request", "--request-file", "<required-graph-request>"],
      status: "passed",
      exitCode: 0,
      assertion: "typed provider failure"
    },
    {
      id: "python-types-degraded-no-tools",
      command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.types"],
      status: "passed",
      exitCode: 0,
      assertion: "Python type tooling degraded instead of passing silently"
    },
    {
      id: "python-source-hygiene-no-ruff",
      command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.source-hygiene"],
      status: "passed",
      exitCode: 0,
      assertion: "Python source hygiene stayed honest without ruff"
    },
    {
      id: "python-relevant-tests-no-pytest",
      command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.relevant-tests"],
      status: "passed",
      exitCode: 0,
      assertion: "Python relevant-tests stayed graph-backed without pytest"
    },
    {
      id: "python-toolchain-degraded-no-tools",
      command: ["opcore", "status"],
      status: "passed",
      exitCode: 0,
      assertion: "Python toolchain absence stayed degraded"
    }
  ];
  assert.deepEqual(
    negativeChecks.map((entry) => entry.id),
    releaseCutoverNegativeCheckIds
  );
  const currentToolGuardrails = retainedCutoverGuardrails();
  assert.deepEqual(
    currentToolGuardrails.map((entry) => entry.id),
    releaseCutoverCurrentToolGuardrailIds
  );
  return {
    schemaVersion: 1,
    issue: "#30",
    origin: "covibes-authored-cutover-proof",
    generatedAt: "2026-06-05T00:00:00.000Z",
    commitSha: "a".repeat(40),
    privateRepo: true,
    packageNames,
    installedPackages: packageNames.map((packageName) => ({
        packageName,
        version: "0.2.0",
        tarball: {
          filename: `${packageName.replace("@the-open-engine/", "the-open-engine-").replace("/", "-")}-0.2.0.tgz`,
          sha256: "1".repeat(64)
        },
        installedManifest: {
          path: `node_modules/${packageName}/package.json`,
          sha256: "3".repeat(64),
          bins:
            packageName === "opcore"
              ? { opcore: "dist/index.js", "opcore-asp-provider": "dist/asp-provider-bin.js" }
                : {}
        },
        installedFiles: installedFilesFor(packageName)
      })),
    descriptor: {
      path: "node_modules/opcore/dist/descriptors/opcore.managed-tool.json",
      packageName: "opcore",
      checksumSha256: "7".repeat(64),
      descriptor,
      resolvedArtifacts: descriptor.artifacts.map((artifact) => ({ ...artifact, packageFile: true })),
      resolvedChecksums: descriptor.checksums.map((checksum) => ({ ...checksum, packageFile: true, value: "8".repeat(64) }))
    },
    environmentIsolation: {
      currentToolEnvCleared: true,
      clearedEnvVarCount: 5,
      pathSanitized: true,
      aceRuntimeBinExcluded: true,
      siblingCovibesExcluded: true,
      opcoreBinOnly: true,
      oldBinsAbsent: { lattice: true, crg: true, cix: true, rox: true }
    },
    commandReceipts,
    rustCommandReceipts,
    pythonCommandReceipts,
    negativeChecks,
    currentToolGuardrails,
    oldToolReplacementClaimed: false,
    forbiddenMarkerScan: {
      scannedTextCount: 1,
      findingCount: 0,
      markersBlocked: ["private-runtime", "current-tool-env", "private-home", "old-tool-bins"]
    },
    inputEvidence: [
      { issue: "#17", path: "docs/release/graph-release-receipt.json", checksumSha256: "4".repeat(64) },
      { issue: "#29", path: "docs/release/release-receipt.json", checksumSha256: "5".repeat(64) },
      { issue: "#58", path: "docs/integration/pre-write-validation.md", checksumSha256: "6".repeat(64) }
    ]
  };
}

function installedFilesFor(packageName) {
  const paths = [
    "package.json",
    ...(packageName === "opcore"
      ? [
          "dist/index.js",
          "dist/asp-provider-bin.js",
          "node_modules/@the-open-engine/opcore-asp-provider/dist/manifests/asp-server.json",
          ...graphCoreNativeSupportedTargets.map(
            (target) => `node_modules/${graphCoreNativePackageNameForTarget(target)}/opcore-graph-core`
          )
        ]
      : [])
  ];
  return paths.map((path) => ({ path: `node_modules/${packageName}/${path}`, sha256: "4".repeat(64) }));
}

function cutoverCommandExpectations() {
  return [
    ["opcore-scan", ["opcore", "scan"], "runtime"],
    ["opcore-status", ["opcore", "status"], "runtime"],
    [
      "opcore-check-changed",
      ["opcore", "check", "changed", "--report-mode", "introduced", "--base", "HEAD", "--checks", "typescript.syntax"],
      "validation"
    ],
    ["opcore-measure", ["opcore", "measure"], "runtime"],
    ["opcore-try", ["opcore", "try"], "runtime"],
    ["status", ["opcore", "status"], "runtime"],
    ["doctor", ["opcore", "doctor"], "runtime", "ok", 0],
    ["graph-build", ["opcore", "graph", "build"], "graph", "ok", 0],
    ["graph-status", ["opcore", "graph", "status"], "graph", "ok", 0],
    ["graph-query", ["opcore", "graph", "query"], "graph", "ok", 0],
    ["graph-impact", ["opcore", "graph", "impact", "--files", "src/components/GreetingCard.tsx"], "graph", "ok", 0],
    ["graph-review-context", ["opcore", "graph", "review-context", "--files", "src/components/GreetingCard.tsx"], "graph", "ok", 0],
    ["graph-detect-changes", ["opcore", "graph", "detect-changes", "--files", "src/components/GreetingCard.tsx"], "graph", "ok", 0],
    ["graph-search", ["opcore", "graph", "search", "Greeting", "--limit", "5"], "graph", "ok", 0],
    ["graph-serve", ["opcore", "graph", "serve"], "graph", "ok", 0],
    ["inspect-symbols", ["opcore", "inspect", "symbols", "Greeting", "--limit", "5"], "inspect", "ok", 0],
    ["inspect-definition", ["opcore", "inspect", "definition", "GreetingCard"], "inspect", "ok", 0],
    ["inspect-references", ["opcore", "inspect", "references", "function:src/components/GreetingCard.tsx#GreetingCard", "--limit", "5"], "inspect", "ok", 0],
    ["inspect-signature", ["opcore", "inspect", "signature", "function:src/components/GreetingCard.tsx#GreetingCard"], "inspect", "ok", 0],
    ["inspect-implementations", ["opcore", "inspect", "implementations", "class:src/models.ts#GreetingModel"], "inspect", "ok", 0],
    ["inspect-search", ["opcore", "inspect", "search", "Greeting", "--limit", "5"], "inspect", "ok", 0],
    [
      "edit-preview",
      [
        "opcore",
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 1;",
        "--replacement",
        "export const cutoverValue: number = 2;"
      ],
      "edit",
      "ok",
      0
    ],
    [
      "edit-apply",
      [
        "opcore",
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 1;",
        "--replacement",
        "export const cutoverValue: number = 2;",
        "--apply"
      ],
      "edit",
      "ok",
      0
    ],
    [
      "edit-refused",
      [
        "opcore",
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 2;",
        "--replacement",
        "export const cutoverValue: number = missingCutoverSymbol;",
        "--apply"
      ],
      "edit",
      "error",
      1
    ],
    ["check-files", ["opcore", "check", "files", "src/cutover.ts", "--checks", "typescript.syntax,typescript.types"], "validation", "ok", 0],
    ["validate-request", ["opcore", "validate", "request", "--request-file", "/tmp/opcore-cutover/project/validate-request.json"], "validation", "ok", 0],
    [
      "validate-pre-write-pass",
      ["opcore", "validate", "pre-write", "--request-file", "/tmp/opcore-cutover/project/pre-write-pass.json", "--timeout-ms", "30000"],
      "validation",
      "ok",
      0
    ],
    [
      "validate-pre-write-fail",
      ["opcore", "validate", "pre-write", "--request-file", "/tmp/opcore-cutover/project/pre-write-fail.json", "--timeout-ms", "30000"],
      "validation",
      "error",
      1
    ]
  ].map(([id, command, owner, status = "ok", exitCode = 0]) => ({
    id,
    command,
    owner,
    status,
    exitCode
  }));
}

function cutoverRustCommandExpectations() {
  return [
    ["graph-rust-build", ["opcore", "graph", "build"], "graph"],
    ["graph-rust-status", ["opcore", "graph", "status"], "graph"],
    ["graph-rust-query", ["opcore", "graph", "query"], "graph"],
    ["graph-rust-impact", ["opcore", "graph", "impact", "--files", "src/helpers.rs"], "graph"],
    ["graph-rust-review-context", ["opcore", "graph", "review-context", "--files", "src/helpers.rs"], "graph"],
    ["graph-rust-detect-changes", ["opcore", "graph", "detect-changes", "--files", "src/helpers.rs"], "graph"],
    ["graph-rust-search", ["opcore", "graph", "search", "Widget", "--limit", "5"], "graph"]
  ].map(([id, command, owner]) => ({
    id,
    command,
    owner,
    status: "ok",
    exitCode: 0
  }));
}

function cutoverPythonCommandExpectations() {
  return [
    ["opcore-python-scan", ["opcore", "scan"], "runtime", ["python-coverage", "python-validation", "python-types-degraded"]],
    ["opcore-python-status", ["opcore", "status"], "runtime", ["python-coverage", "python-validation"]],
    [
      "opcore-python-check-changed",
      [
        "opcore",
        "check",
        "changed",
        "--report-mode",
        "introduced",
        "--base",
        "HEAD",
        "--checks",
        "python.syntax,python.source-hygiene"
      ],
      "validation",
      ["python-syntax", "python-source-hygiene"]
    ],
    ["opcore-python-measure", ["opcore", "measure"], "runtime", ["python-measure-delta"]],
    ["graph-python-build", ["opcore", "graph", "build"], "graph", ["python-graph-provider"]],
    ["graph-python-status", ["opcore", "graph", "status"], "graph", ["python-graph-provider"]],
    ["graph-python-query", ["opcore", "graph", "query"], "graph", ["src/acme/app.py", "Greeter", "build_name"]],
    ["graph-python-search", ["opcore", "graph", "search", "Greeter", "--limit", "5"], "graph", ["src/acme/app.py", "Greeter"]]
  ].map(([id, command, owner, evidence]) => ({
    id,
    command,
    owner,
    evidence,
    status: "ok",
    exitCode: 0
  }));
}

function commandReceipt(expectation, bin = expectation.command[0], assertionSuffix = "passed") {
  return {
    id: expectation.id,
    command: expectation.command,
    canonicalCommand: expectation.command,
    ...(expectation.evidence === undefined ? {} : { evidence: expectation.evidence }),
    owner: expectation.owner,
    status: expectation.status,
    exitCode: expectation.exitCode,
    binPath: `node_modules/.bin/${bin}`,
    stdoutSha256: "1".repeat(64),
    stderrSha256: "2".repeat(64),
    assertion: `${expectation.id} ${assertionSuffix}`
  };
}

function retainedCutoverGuardrails() {
  return [
    {
      id: "current-tools-validate-changed",
      command: ["npm", "run", "current-tools:validate-changed"],
      status: "passed",
      exitCode: 0,
      stdoutSha256: "1".repeat(64),
      stderrSha256: "2".repeat(64),
      retained: true,
      assertion: "retained changed-file guardrail",
      oldToolReplacementClaimed: false
    },
    {
      id: "current-tools-validate-rust-graph",
      command: ["npm", "run", "current-tools:validate-rust-graph"],
      status: "passed",
      exitCode: 0,
      stdoutSha256: "1".repeat(64),
      stderrSha256: "2".repeat(64),
      retained: true,
      assertion: "retained Rust graph guardrail",
      oldToolReplacementClaimed: false
    }
  ];
}
