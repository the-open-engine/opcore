import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createValidationCheckRegistry, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  DOCS_CODE_BLOCKS_CHECK_ID,
  DOCS_CONTENT_QUALITY_CHECK_ID,
  DOCS_DRY_CHECK_ID,
  DOCS_EXISTENCE_CHECK_ID,
  DOCS_FRESHNESS_CHECK_ID,
  DOCS_HUB_COVERAGE_CHECK_ID,
  DOCS_LENGTH_CHECK_ID,
  DOCS_RULES_WHY_CHECK_ID,
  DOCS_STALENESS_CHECK_ID,
  createDocsValidationChecks,
  docsValidationCheckIds,
  validationDocsAdapterName
} from "../packages/validation-docs/dist/index.js";
import {
  availableFactResult,
  fileNode,
  git,
  graphClient,
  graphEdgesForSelector,
  graphNodesForSelector,
  nodeWorkspace,
  request,
  runner,
  validGuidance
} from "./helpers/validation-docs-fixtures.mjs";

const expectedDocsCheckIds = [
  DOCS_EXISTENCE_CHECK_ID,
  DOCS_STALENESS_CHECK_ID,
  DOCS_FRESHNESS_CHECK_ID,
  DOCS_LENGTH_CHECK_ID,
  DOCS_DRY_CHECK_ID,
  DOCS_CONTENT_QUALITY_CHECK_ID,
  DOCS_CODE_BLOCKS_CHECK_ID,
  DOCS_RULES_WHY_CHECK_ID,
  DOCS_HUB_COVERAGE_CHECK_ID
];

  it("exports stable docs check ids and definitions", () => {
    const checks = createDocsValidationChecks();
    const registry = createValidationCheckRegistry(checks);

    assert.equal(validationDocsAdapterName, "docs");
    assert.deepEqual(docsValidationCheckIds, expectedDocsCheckIds);
    assert.deepEqual(checks.map((check) => check.id), expectedDocsCheckIds);
    assert.equal(registry.byId.get(DOCS_EXISTENCE_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(DOCS_HUB_COVERAGE_CHECK_ID)?.requiresGraph, true);
    assert.deepEqual(registry.byId.get(DOCS_EXISTENCE_CHECK_ID)?.supportedScopes, ["all", "repo", "package"]);
    assert.deepEqual(registry.byId.get(DOCS_HUB_COVERAGE_CHECK_ID)?.supportedScopes, ["all", "repo", "package"]);
    assert.equal(registry.byId.get(DOCS_LENGTH_CHECK_ID)?.defaultScopes?.length, 0);
  });

  it("reports missing required context docs from the shared policy", async () => {
    const result = await runner({
      files: {
        "src/app.ts": "export const value = 1;\n"
      }
    }).runValidation(
      request({
        checks: [DOCS_EXISTENCE_CHECK_ID],
        scope: { kind: "repo" }
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["DOCS_REQUIRED_CONTEXT_DOC_MISSING"]);
    assert.match(result.diagnostics[0].message, /AGENTS\.md or CLAUDE\.md/);
  });

  it("reports length, duplicate, content quality, code-block, and rule rationale diagnostics from overlay content", async () => {
    const duplicateParagraph =
      "This repeated operational paragraph is intentionally long enough to be useful, and it appears in more than one guidance document.";
    const result = await runner({
      files: {
        "AGENTS.md": "UPDATE THIS FILE when conventions change.\n\n"
      }
    }).runValidation(
      request({
        checks: [
          DOCS_LENGTH_CHECK_ID,
          DOCS_DRY_CHECK_ID,
          DOCS_CONTENT_QUALITY_CHECK_ID,
          DOCS_CODE_BLOCKS_CHECK_ID,
          DOCS_RULES_WHY_CHECK_ID
        ],
        scope: { kind: "files", files: ["AGENTS.md", "CLAUDE.md", "docs/guide.md"] },
        overlays: [
          {
            path: "AGENTS.md",
            action: "write",
            content: [
              "UPDATE THIS FILE when conventions change.",
              "",
              "ALWAYS keep builds green.",
              "",
              "TODO: replace this placeholder.",
              "",
              "```sh",
              "npm test",
              "",
              duplicateParagraph,
              ""
            ].join("\n")
          },
          {
            path: "CLAUDE.md",
            action: "write",
            content: "# Short\n"
          },
          {
            path: "docs/guide.md",
            action: "write",
            content: ["# Contributor guidance", "", duplicateParagraph, ""].join("\n")
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      [
        "DOCS_CODE_BLOCK_UNCLOSED",
        "DOCS_CONTENT_PLACEHOLDER",
        "DOCS_DRY_DUPLICATE_PARAGRAPH",
        "DOCS_RULE_WITHOUT_WHY",
        "DOCS_TOO_SHORT"
      ]
    );
    assert.equal(result.diagnostics.every((diagnostic) => ["AGENTS.md", "CLAUDE.md", "docs/guide.md"].includes(diagnostic.path)), true);
  });

  it("reports stale committed docs and docs older than scoped implementation files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-docs-history-"));
    try {
      writeFileSync(join(temp, "AGENTS.md"), validGuidance("initial architecture guidance"));
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/app.ts"), "export const value = 1;\n");
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "docs@example.test"]);
      git(temp, ["config", "user.name", "Docs Test"]);
      git(temp, ["add", "AGENTS.md"]);
      git(temp, ["commit", "-m", "docs", "--date", "2024-01-01T00:00:00Z"], {
        GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z"
      });
      git(temp, ["add", "src/app.ts"]);
      git(temp, ["commit", "-m", "source", "--date", "2024-02-01T00:00:00Z"], {
        GIT_AUTHOR_DATE: "2024-02-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2024-02-01T00:00:00Z"
      });

      const result = await createValidationRunner({
        workspace: nodeWorkspace(temp),
        checks: createDocsValidationChecks({
          history: { now: "2024-04-15T00:00:00Z", maxStaleDays: 30 }
        })
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [DOCS_STALENESS_CHECK_ID, DOCS_FRESHNESS_CHECK_ID],
          scope: { kind: "repo" }
        })
      );

      assert.equal(result.status, "passed");
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
        ["DOCS_OLDER_THAN_CODE", "DOCS_STALE"]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports stale file references from committed context docs", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": `${validGuidance("stale reference")}\nSee \`src/missing.ts\` for the old entrypoint.\n`,
        "src/app.ts": "export const value = 1;\n"
      },
      checks: createDocsValidationChecks({
        history: { now: "2024-04-15T00:00:00Z", maxStaleDays: 3650 }
      })
    }).runValidation(
      request({
        checks: [DOCS_FRESHNESS_CHECK_ID],
        scope: { kind: "repo" }
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["DOCS_STALE_REFERENCE"]);
    assert.match(result.diagnostics[0].message, /src\/missing\.ts/);
  });

  it("reports stale file references introduced by overlay context docs", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": validGuidance("overlay stale reference"),
        "src/app.ts": "export const value = 1;\n"
      },
      checks: createDocsValidationChecks({
        history: { now: "2024-04-15T00:00:00Z", maxStaleDays: 3650 }
      })
    }).runValidation(
      request({
        checks: [DOCS_FRESHNESS_CHECK_ID],
        scope: { kind: "files", files: ["AGENTS.md"] },
        overlays: [
          {
            path: "AGENTS.md",
            action: "write",
            content: `${validGuidance("overlay stale reference")}\nSee \`src/missing.ts\` for the new entrypoint.\n`
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["DOCS_STALE_REFERENCE"]);
    assert.match(result.diagnostics[0].message, /src\/missing\.ts/);
  });

  it("does not report stale file references repaired by overlays", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": `${validGuidance("overlay repaired reference")}\nSee \`src/missing.ts\` for the entrypoint.\n`
      },
      checks: createDocsValidationChecks({
        history: { now: "2024-04-15T00:00:00Z", maxStaleDays: 3650 }
      })
    }).runValidation(
      request({
        checks: [DOCS_FRESHNESS_CHECK_ID],
        scope: { kind: "files", files: ["AGENTS.md", "src/missing.ts"] },
        overlays: [{ path: "src/missing.ts", action: "write", content: "export const repaired = true;\n" }]
      })
    );

    assert.equal(result.status, "skipped");
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.manifest.runs[0].failureMessage, /overlays are present/);
  });

  it("degrades committed-state freshness and staleness checks when overlays are present", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": validGuidance("overlay guidance")
      },
      checks: createDocsValidationChecks({ history: { now: "2024-04-15T00:00:00Z", maxStaleDays: 1 } })
    }).runValidation(
      request({
        checks: [DOCS_STALENESS_CHECK_ID, DOCS_FRESHNESS_CHECK_ID],
        scope: { kind: "files", files: ["AGENTS.md"] },
        overlays: [{ path: "AGENTS.md", action: "write", content: validGuidance("overlaid guidance") }]
      })
    );

    assert.equal(result.status, "skipped");
    assert.deepEqual(
      result.manifest.runs.map((run) => [run.checkId, run.status]),
      [
        [DOCS_STALENESS_CHECK_ID, "skipped"],
        [DOCS_FRESHNESS_CHECK_ID, "skipped"]
      ]
    );
    assert.match(result.manifest.runs[0].failureMessage, /committed state/);
  });

  it("skips Git-history docs checks honestly when repository history is unavailable", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": validGuidance("history unavailable")
      }
    }).runValidation(
      request({
        checks: [DOCS_STALENESS_CHECK_ID],
        scope: { kind: "repo" }
      })
    );

    assert.equal(result.status, "skipped");
    assert.equal(result.manifest.runs[0].status, "skipped");
    assert.match(result.manifest.runs[0].failureMessage, /Git history is unavailable/);
  });

  it("skips graph-backed hub coverage when graph is unavailable", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": validGuidance("hub coverage")
      }
    }).runValidation(
      request({
        checks: [DOCS_HUB_COVERAGE_CHECK_ID],
        scope: { kind: "repo" }
      })
    );

    assert.equal(result.status, "skipped");
    assert.equal(result.manifest.skippedChecks[0].reason, "graph_unavailable");
  });

  it("reports uncovered graph hub files when graph is available", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": validGuidance("hub coverage")
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            graphNodesForSelector(query, [
              fileNode("src/hub.ts"),
              fileNode("src/a.ts"),
              fileNode("src/b.ts"),
              fileNode("src/c.ts")
            ]),
            graphEdgesForSelector(query, [
              { kind: "IMPORTS_FROM", from: "file:src/a.ts", to: "file:src/hub.ts" },
              { kind: "IMPORTS_FROM", from: "file:src/b.ts", to: "file:src/hub.ts" },
              { kind: "IMPORTS_FROM", from: "file:src/c.ts", to: "file:src/hub.ts" }
            ])
          )
      })
    }).runValidation(
      request({
        checks: [DOCS_HUB_COVERAGE_CHECK_ID],
        scope: { kind: "repo" }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["DOCS_HUB_UNDOCUMENTED"]);
    assert.match(result.diagnostics[0].message, /src\/hub\.ts/);
  });

  it("rejects repo-wide docs checks for scoped-only validation requests", async () => {
    const result = await runner({
      files: {
        "AGENTS.md": validGuidance("scoped rejection")
      }
    }).runValidation(
      request({
        checks: [DOCS_EXISTENCE_CHECK_ID],
        scope: { kind: "files", files: ["AGENTS.md"] }
      })
    );

    assert.equal(result.status, "unsupported_request");
    assert.match(result.failure.message, /does not support files scope/);
  });

  it("reads overlay docs without creating persisted cache artifacts", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-docs-overlay-"));
    try {
      writeFileSync(join(temp, "AGENTS.md"), validGuidance("persisted before overlay"));
      const result = await createValidationRunner({
        workspace: nodeWorkspace(temp),
        checks: createDocsValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [DOCS_LENGTH_CHECK_ID],
          scope: { kind: "files", files: ["AGENTS.md"] },
          overlays: [{ path: "AGENTS.md", action: "write", content: "# Short\n" }]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.equal(readFileSync(join(temp, "AGENTS.md"), "utf8"), validGuidance("persisted before overlay"));
      assert.equal(existsSync(join(temp, ".lattice", "docs")), false);
      assert.equal(existsSync(join(temp, ".opcore", "docs")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
