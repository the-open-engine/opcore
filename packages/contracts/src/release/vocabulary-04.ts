import type { ReleaseCutoverPythonCommandId, ReleaseCutoverRustCommandId } from "./vocabulary-01.js";
import type {
  ReleaseCutoverCommandExpectation,
  ReleaseCutoverNegativeCheckId} from "./vocabulary-02.js";
import {
  releaseCutoverMissingGraphRepoPlaceholder,
  releaseCutoverRequiredGraphRequestPlaceholder,
} from "./vocabulary-02.js";

const releaseCutoverRustCommandExpectations = {
  "graph-rust-build": {
    canonicalCommand: ["opcore", "graph", "build"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-rust-status": {
    canonicalCommand: ["opcore", "graph", "status"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-rust-query": {
    canonicalCommand: ["opcore", "graph", "query"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-rust-impact": {
    canonicalCommand: ["opcore", "graph", "impact", "--files", "src/helpers.rs"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-rust-review-context": {
    canonicalCommand: ["opcore", "graph", "review-context", "--files", "src/helpers.rs"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-rust-detect-changes": {
    canonicalCommand: ["opcore", "graph", "detect-changes", "--files", "src/helpers.rs"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-rust-search": {
    canonicalCommand: ["opcore", "graph", "search", "Widget", "--limit", "5"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
} as const satisfies Record<ReleaseCutoverRustCommandId, ReleaseCutoverCommandExpectation>;

export { releaseCutoverRustCommandExpectations };

const releaseCutoverPythonCommandExpectations = {
  "opcore-python-scan": {
    canonicalCommand: ["opcore", "scan"],
    owner: "runtime",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "opcore-python-status": {
    canonicalCommand: ["opcore", "status"],
    owner: "runtime",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "opcore-python-check-changed": {
    canonicalCommand: [
      "opcore",
      "check",
      "changed",
      "--report-mode",
      "introduced",
      "--base",
      "HEAD",
      "--checks",
      "python.syntax,python.source-hygiene",
    ],
    owner: "validation",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "opcore-python-measure": {
    canonicalCommand: ["opcore", "measure"],
    owner: "runtime",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-python-build": {
    canonicalCommand: ["opcore", "graph", "build"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-python-status": {
    canonicalCommand: ["opcore", "graph", "status"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-python-query": {
    canonicalCommand: ["opcore", "graph", "query"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
  "graph-python-search": {
    canonicalCommand: ["opcore", "graph", "search", "Greeter", "--limit", "5"],
    owner: "graph",
    status: "ok",
    exitCode: 0,
    bin: "opcore",
  },
} as const satisfies Record<ReleaseCutoverPythonCommandId, ReleaseCutoverCommandExpectation>;

export { releaseCutoverPythonCommandExpectations };

const releaseCutoverPythonEvidenceExpectations = {
  "opcore-python-scan": ["python-coverage", "python-validation", "python-types-degraded"],
  "opcore-python-status": ["python-coverage", "python-validation"],
  "opcore-python-check-changed": ["python-syntax", "python-source-hygiene"],
  "opcore-python-measure": ["python-measure-delta"],
  "graph-python-build": ["python-graph-provider"],
  "graph-python-status": ["python-graph-provider"],
  "graph-python-query": ["src/acme/app.py", "Greeter", "build_name"],
  "graph-python-search": ["src/acme/app.py", "Greeter"],
} as const satisfies Record<ReleaseCutoverPythonCommandId, readonly string[]>;

export { releaseCutoverPythonEvidenceExpectations };

const releaseCutoverNegativeCheckExpectations = {
  "missing-required-graph-check": [
    "opcore",
    "check",
    "files",
    "src/index.ts",
    "--repo",
    releaseCutoverMissingGraphRepoPlaceholder,
    "--graph-mode",
    "required",
    "--checks",
    "typescript.import-graph",
  ],
  "missing-required-graph-validate": [
    "opcore",
    "validate",
    "request",
    "--request-file",
    releaseCutoverRequiredGraphRequestPlaceholder,
  ],
  "python-types-degraded-no-tools": ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.types"],
  "python-source-hygiene-no-ruff": ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.source-hygiene"],
  "python-relevant-tests-no-pytest": [
    "opcore",
    "check",
    "files",
    "src/acme/app.py",
    "--checks",
    "python.relevant-tests",
  ],
  "python-toolchain-degraded-no-tools": ["opcore", "status"],
} as const satisfies Record<ReleaseCutoverNegativeCheckId, readonly string[]>;

export { releaseCutoverNegativeCheckExpectations };
