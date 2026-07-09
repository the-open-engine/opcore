import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateValidationFileChecksum,
  createNodeValidationWorkspace,
  createValidationCheckRegistry,
  createValidationRunner
} from "../packages/validation/dist/index.js";
import {
  CLONE_DUPLICATION_CHECK_ID,
  cloneValidationCheckIds,
  createCloneValidationChecks,
  validationCloneAdapterName
} from "../packages/validation-clone/dist/index.js";
import { CLONE_PROTOCOL } from "../packages/contracts/dist/index.js";
import { invokeCloneAnalysis } from "../packages/opcore/dist/clone-invoker.js";

it("exports the clone duplication check with an injected native invoker", async () => {
  const captured = {};
  const checks = createCloneValidationChecks({
    invoke: capturingCloneInvoker(captured)
  });
  const registry = createValidationCheckRegistry(checks);

  assert.equal(validationCloneAdapterName, "clone");
  assert.deepEqual(cloneValidationCheckIds, [CLONE_DUPLICATION_CHECK_ID]);
  assert.equal(registry.byId.get(CLONE_DUPLICATION_CHECK_ID).requiresGraph, false);

  const result = await runner(checks).runValidation(validationCloneRequest());

  assertCapturedCloneRequest(captured.request);
  assertCloneDiagnosticResult(result);
});

it("passes clone policy fields into the native request", async () => {
  const captured = {};
  const checks = createCloneValidationChecks({
    invoke: capturingCloneInvoker(captured),
    windowSize: 8,
    minLines: 6,
    minTokens: 24,
    threshold: 3,
    partitions: [["server", "shared"], ["client"]],
    exclude: ["docs/**", "dist"],
    modes: ["staged", "changed", "files"]
  });

  const result = await runner(checks).runValidation(validationCloneRequest());

  assert.equal(result.status, "policy_failure");
  assert.equal(captured.request.windowSize, 8);
  assert.equal(captured.request.minLines, 6);
  assert.equal(captured.request.minTokens, 24);
  assert.equal(captured.request.threshold, 3);
  assert.deepEqual(captured.request.partitions, [["server", "shared"], ["client"]]);
  assert.deepEqual(captured.request.exclude, ["docs/**", "dist"]);
  assert.deepEqual(captured.request.modes, ["staged", "changed", "files"]);
});

function capturingCloneInvoker(captured) {
  return (request) => {
    captured.request = request;
    return cloneAnalysisResultFor(request);
  };
}

function cloneAnalysisResultFor(request) {
  const findings = request.overlays.some(
    (overlay) => overlay.path === "src/a.ts" && overlay.action === "write" && overlay.content.includes("after")
  )
    ? [
        {
          cloneClassId: "clone-0123456789abcdef",
          contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          path: "src/a.ts",
          peerPath: "src/b.ts",
          paths: ["src/a.ts", "src/b.ts"],
          lineCount: 6,
          tokenCount: 24,
          introduced: true
        }
      ]
    : [];
  return {
    protocol: CLONE_PROTOCOL,
    requestId: request.requestId,
    schemaVersion: 1,
    repo: request.repo,
    reportMode: request.reportMode,
    status: "passed",
    persisted: false,
    findings,
    summary: {
      analyzedFiles: 2,
      cloneClassCount: findings.length > 0 ? 1 : 0,
      findingCount: findings.length,
      overlayCount: request.overlays.length
    }
  };
}

function validationCloneRequest() {
  return {
    requestId: "validation-clone-1",
    repo: {
      repoId: "clone-test"
    },
    scope: {
      kind: "files",
      files: ["src/a.ts", "src/b.ts"]
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    reportMode: "introduced",
    checks: [CLONE_DUPLICATION_CHECK_ID],
    overlays: [
      {
        path: "src/a.ts",
        action: "write",
        checksumBefore: calculateValidationFileChecksum("export const before = 1;\n"),
        content: "export const after = 1;\n"
      }
    ]
  };
}

function assertCapturedCloneRequest(request) {
  assert.equal(request.protocol, CLONE_PROTOCOL);
  assert.equal(request.reportMode, "introduced");
  assert.deepEqual(request.paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(request.overlays, [
    {
      path: "src/a.ts",
      action: "write",
      content: "export const after = 1;\n",
      checksumBefore: calculateValidationFileChecksum("export const before = 1;\n")
    },
    {
      path: "src/b.ts",
      action: "write",
      content: "export const peer = 1;\n"
    }
  ]);
}

function assertCloneDiagnosticResult(result) {
  assert.equal(result.status, "policy_failure");
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    category: "policy",
    severity: "error",
    code: "CLONE_DUPLICATE",
    path: "src/a.ts",
    message: "Duplicate code clone-0123456789abcdef in src/a.ts also appears in src/b.ts."
  });
  assert.equal(Object.hasOwn(result.diagnostics[0], "line"), false);
}

it("maps native clone invocation failures to infrastructure failures", async () => {
  const result = await runner(
    createCloneValidationChecks({
      invoke: () => {
        throw new Error("native clone failed");
      }
    })
  ).runValidation({
    requestId: "validation-clone-failure-1",
    repo: {
      repoId: "clone-test"
    },
    scope: {
      kind: "files",
      files: ["src/a.ts"]
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    checks: [CLONE_DUPLICATION_CHECK_ID],
    overlays: []
  });

  assert.equal(result.status, "infrastructure_failure");
  assert.match(result.failure.cause, /native clone failed/);
});

it("materializes staged and tree after-state as clone overlays without explicit overlays", async () => {
  const captured = [];
  const validationRunner = capturedCloneValidationRunner(afterStateWorkspace(), captured);

  assert.equal((await validationRunner.runValidation(stagedAfterStateRequest())).status, "passed");
  assert.equal((await validationRunner.runValidation(treeAfterStateRequest())).status, "passed");

  assert.deepEqual(capturedCloneRequestSummaries(captured), expectedAfterStateCloneRequests());
});

it("validates changed-scope after-state clones without persisting dirty or untracked indexes", async () => {
  const temp = mkdtempSync(join(tmpdir(), "opcore-validation-clone-changed-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    const duplicateBlock = cloneDuplicateBlock();
    writeFileSync(join(temp, "src/peer.ts"), duplicateBlock);
    writeFileSync(join(temp, "src/changed.ts"), "export const before = 1;\n");
    const baseCommit = initializeGitSnapshot(temp, ["src/peer.ts", "src/changed.ts"]);
    writeFileSync(join(temp, "src/changed.ts"), duplicateBlock);
    writeFileSync(join(temp, "src/untracked.ts"), duplicateBlock);

    const result = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createCloneValidationChecks({ invoke: invokeCloneAnalysis })
    }).runValidation({
      requestId: "validation-clone-changed-after-state",
      repo: {
        repoRoot: temp
      },
      scope: {
        kind: "changed",
        baseRef: baseCommit
      },
      graph: {
        mode: "optional",
        provider: "opcore-graph"
      },
      reportMode: "introduced",
      checks: [CLONE_DUPLICATION_CHECK_ID],
      overlays: []
    });

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.path === "src/changed.ts" && diagnostic.code === "CLONE_DUPLICATE"),
      JSON.stringify(result.diagnostics, null, 2)
    );
    assert.equal(existsSync(join(temp, ".opcore/clone/clone.db")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("validates staged after-state clones against staged peers instead of dirty disk peers", async () => {
  const temp = mkdtempSync(join(tmpdir(), "opcore-validation-clone-staged-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    const duplicateBlock = cloneDuplicateBlock();
    writeFileSync(join(temp, "src/peer.ts"), duplicateBlock);
    writeFileSync(join(temp, "src/staged.ts"), "export const before = 1;\n");
    initializeGitSnapshot(temp, ["src/peer.ts", "src/staged.ts"]);
    writeFileSync(join(temp, "src/staged.ts"), duplicateBlock);
    git(temp, ["add", "src/staged.ts"]);
    writeFileSync(join(temp, "src/peer.ts"), "export const dirtyPeer = 1;\n");

    const result = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createCloneValidationChecks({ invoke: invokeCloneAnalysis })
    }).runValidation({
      requestId: "validation-clone-staged-peer-after-state",
      repo: {
        repoRoot: temp
      },
      scope: {
        kind: "staged"
      },
      graph: {
        mode: "optional",
        provider: "opcore-graph"
      },
      reportMode: "all",
      checks: [CLONE_DUPLICATION_CHECK_ID],
      overlays: []
    });

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.path === "src/staged.ts" && diagnostic.code === "CLONE_DUPLICATE"),
      JSON.stringify(result.diagnostics, null, 2)
    );
    assert.equal(existsSync(join(temp, ".opcore/clone/clone.db")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("validates tree after-state clones against tree peers instead of dirty disk peers", async () => {
  const temp = mkdtempSync(join(tmpdir(), "opcore-validation-clone-tree-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    const duplicateBlock = cloneDuplicateBlock();
    writeFileSync(join(temp, "src/peer.ts"), duplicateBlock);
    writeFileSync(join(temp, "src/tree.ts"), "export const before = 1;\n");
    const baseCommit = initializeGitSnapshot(temp, ["src/peer.ts", "src/tree.ts"]);
    writeFileSync(join(temp, "src/tree.ts"), duplicateBlock);
    git(temp, ["add", "src/tree.ts"]);
    const targetTree = git(temp, ["write-tree"]).stdout.trim();
    const targetCommit = git(temp, ["commit-tree", targetTree, "-p", baseCommit, "-m", "target"], {
      GIT_AUTHOR_NAME: "Opcore",
      GIT_AUTHOR_EMAIL: "opcore@example.invalid",
      GIT_AUTHOR_DATE: "2026-06-28T00:00:01Z",
      GIT_COMMITTER_NAME: "Opcore",
      GIT_COMMITTER_EMAIL: "opcore@example.invalid",
      GIT_COMMITTER_DATE: "2026-06-28T00:00:01Z"
    }).stdout.trim();
    writeFileSync(join(temp, "src/peer.ts"), "export const dirtyPeer = 1;\n");

    const result = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createCloneValidationChecks({ invoke: invokeCloneAnalysis })
    }).runValidation({
      requestId: "validation-clone-tree-peer-after-state",
      repo: {
        repoRoot: temp
      },
      scope: {
        kind: "tree",
        treeRef: targetCommit,
        changedFrom: baseCommit
      },
      graph: {
        mode: "optional",
        provider: "opcore-graph"
      },
      reportMode: "all",
      checks: [CLONE_DUPLICATION_CHECK_ID],
      overlays: []
    });

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.path === "src/tree.ts" && diagnostic.code === "CLONE_DUPLICATE"),
      JSON.stringify(result.diagnostics, null, 2)
    );
    assert.equal(existsSync(join(temp, ".opcore/clone/clone.db")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function runner(checks) {
  const files = new Map([
    ["src/a.ts", "export const before = 1;\n"],
    ["src/b.ts", "export const peer = 1;\n"]
  ]);
  return createValidationRunner({
    workspace: {
      readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
      listChangedFiles: () => ({ files: [...files.keys()] }),
      listStagedFiles: () => ({ files: [...files.keys()] }),
      listRepoFiles: () => ({ files: [...files.keys()] }),
      listTreeFiles: () => ({ files: [...files.keys()] }),
      listPackageFiles: (_name, root) => ({ files: [...files.keys()].filter((path) => path.startsWith(`${root}/`)) })
    },
    checks
  });
}

function capturedCloneValidationRunner(workspace, captured) {
  return createValidationRunner({
    workspace,
    checks: createCloneValidationChecks({
      invoke: (request) => {
        captured.push(request);
        return cloneAnalysisResultFor(request);
      }
    })
  });
}

function stagedAfterStateRequest() {
  return cloneValidationRequest({
    requestId: "validation-clone-staged-after-state",
    scope: {
      kind: "staged"
    },
    reportMode: "all",
    overlays: []
  });
}

function treeAfterStateRequest() {
  return cloneValidationRequest({
    requestId: "validation-clone-tree-after-state",
    scope: {
      kind: "tree",
      treeRef: "feature",
      changedFrom: "main"
    },
    reportMode: "all",
    overlays: []
  });
}

function cloneValidationRequest(overrides) {
  return {
    repo: {
      repoId: "clone-test"
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    checks: [CLONE_DUPLICATION_CHECK_ID],
    ...overrides
  };
}

function capturedCloneRequestSummaries(requests) {
  return requests.map((request) => ({
    requestId: request.requestId,
    paths: request.paths,
    overlays: request.overlays
  }));
}

function expectedAfterStateCloneRequests() {
  return [
    {
      requestId: "validation-clone-staged-after-state",
      paths: ["src/staged.ts"],
      overlays: [
        {
          path: "src/staged.ts",
          action: "write",
          content: "export const value = 'staged';\n"
        }
      ]
    },
    {
      requestId: "validation-clone-tree-after-state",
      paths: ["src/tree.ts"],
      overlays: [
        {
          path: "src/tree.ts",
          action: "write",
          content: "export const value = 'tree';\n"
        }
      ]
    }
  ];
}

function cloneDuplicateBlock() {
  return [
    "export function duplicated() {",
    "  const one = 1;",
    "  const two = 2;",
    "  const three = 3;",
    "  const four = one + two;",
    "  const five = three + four;",
    "  const six = one + two + three + four + five;",
    "  return six + five + four + three + two + one;",
    "}",
    ""
  ].join("\n");
}

function afterStateWorkspace() {
  return {
    readFile: (path, context) => {
      if (context?.scope.kind === "staged" && path === "src/staged.ts") {
        return { status: "found", content: "export const value = 'staged';\n" };
      }
      if (context?.scope.kind === "tree" && path === "src/tree.ts") {
        return { status: "found", content: "export const value = 'tree';\n" };
      }
      return { status: "found", content: "export const value = 'disk';\n" };
    },
    listChangedFiles: () => ({ files: [] }),
    listStagedFiles: () => ({ files: ["src/staged.ts"] }),
    listRepoFiles: () => ({ files: ["src/staged.ts", "src/tree.ts"] }),
    listTreeFiles: () => ({ files: ["src/tree.ts"] }),
    listPackageFiles: (_name, root) => ({
      files: ["src/staged.ts", "src/tree.ts"].filter((path) => path.startsWith(`${root}/`))
    })
  };
}

function initializeGitSnapshot(repoRoot, files) {
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const file of files) {
    const object = git(repoRoot, ["hash-object", "-w", file]).stdout.trim();
    git(repoRoot, ["update-index", "--add", "--cacheinfo", "100644", object, file]);
  }
  const tree = git(repoRoot, ["write-tree"]).stdout.trim();
  const commit = git(repoRoot, ["commit-tree", tree, "-m", "initial"], {
    GIT_AUTHOR_NAME: "Opcore",
    GIT_AUTHOR_EMAIL: "opcore@example.invalid",
    GIT_AUTHOR_DATE: "2026-06-28T00:00:00Z",
    GIT_COMMITTER_NAME: "Opcore",
    GIT_COMMITTER_EMAIL: "opcore@example.invalid",
    GIT_COMMITTER_DATE: "2026-06-28T00:00:00Z"
  }).stdout.trim();
  git(repoRoot, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error([`git ${args.join(" ")} failed`, result.stdout, result.stderr].join("\n"));
  }
  return result;
}
