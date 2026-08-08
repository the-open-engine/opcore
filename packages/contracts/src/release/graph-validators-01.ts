import { includesString } from "../shared/primitives.js";
import {
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateStringArray,
} from "../shared/validators-01.js";
import {
  validateExactValue,
  validateRequiredObject,
} from "../shared/validators-02.js";
import type {
  GraphReleaseBenchmarkReceipt,
  GraphReleaseCommandCoverage,
  GraphReleaseDirectSqliteQueryReceipt,
  GraphReleasePackageVersion,
  GraphReleaseRustCommandCoverage,
  GraphReleaseServeTransportReceipt,
} from "./graph-contracts.js";
import {
  validateGraphReleaseBenchmarkMetric,
  validateGraphReleaseCoreCommandId,
  validateGraphReleaseRustCommandId,
} from "./graph-validators-02.js";
import {
  graphReleaseOperationForServeTransportId,
  graphReleaseRouteForCommandId,
  graphReleaseRouteForRustCommandId,
  validateGraphReleaseServeTransportId,
} from "./graph-validators-03.js";
import {
  graphReleaseBenchmarkMetrics,
  graphReleaseCoreCommandIds,
  graphReleaseRustCommandIds,
} from "./graph-vocabulary-01.js";
import { graphReleaseDirectSqliteQueryIds, graphReleaseServeTransportIds } from "./graph-vocabulary-02.js";

function validateGraphReleasePackageVersions(versions: readonly GraphReleasePackageVersion[]): void {
  validateNonEmptyArray(versions, "Graph release graphPackageVersions");
  for (const version of versions) {
    if (!version || typeof version !== "object") throw new Error("Graph release package version is required");
    validateNonEmptyString(version.packageName, "Graph release package version packageName");
    validateNonEmptyString(version.version, "Graph release package version version");
  }
  if (!versions.some((version) => version.packageName === "@the-open-engine/opcore-graph")) {
    throw new Error("Graph release package versions must include @the-open-engine/opcore-graph");
  }
}

export { validateGraphReleasePackageVersions };

function validateGraphReleaseCommandCoverage(coverage: readonly GraphReleaseCommandCoverage[]): void {
  validateNonEmptyArray(coverage, "Graph release commandCoverage");
  validateExactStringSet(
    coverage.map((entry) => entry.id),
    graphReleaseCoreCommandIds,
    "Graph release command coverage ids",
  );
  for (const entry of coverage) validateGraphReleaseCommandCoverageEntry(entry);
}

export { validateGraphReleaseCommandCoverage };

function validateGraphReleaseCommandCoverageEntry(entry: GraphReleaseCommandCoverage): void {
  validateRequiredObject(entry, "Graph release command coverage entry is required");
  validateGraphReleaseCoreCommandId(entry.id);
  validateExactValue(entry.bin, "opcore", `Unknown graph release command bin: ${String(entry.bin)}`);
  validateStringArray(entry.command, "Graph release command coverage command", { allowEmpty: false });
  validateStringArray(entry.canonicalCommand, "Graph release command coverage canonicalCommand", {
    allowEmpty: false,
  });
  validateExactValue(entry.status, "passed", "Graph release command coverage status must be passed");
  validateExactValue(entry.exitCode, 0, "Graph release command coverage exitCode must be 0");
  validateNonEmptyString(entry.fixture, "Graph release command coverage fixture");
  if (typeof entry.durationMs !== "number" || entry.durationMs <= 0) {
    throw new Error("Graph release command coverage durationMs must be positive");
  }
  const route = graphReleaseRouteForCommandId(entry.id);
  validateExactValue(entry.bin, route.bin, `Graph release command ${entry.id} must use ${route.bin}`);
  validateExactValue(
    entry.command.join("\0"),
    route.command.join("\0"),
    `Graph release command ${entry.id} command must be ${route.command.join(" ")}`,
  );
  validateExactValue(
    entry.canonicalCommand.join("\0"),
    route.canonicalCommand.join("\0"),
    `Graph release command ${entry.id} canonicalCommand must be ${route.canonicalCommand.join(" ")}`,
  );
}

function validateGraphReleaseRustCommandCoverage(coverage: readonly GraphReleaseRustCommandCoverage[]): void {
  validateNonEmptyArray(coverage, "Graph release rustCommandCoverage");
  validateExactStringSet(
    coverage.map((entry) => entry.id),
    graphReleaseRustCommandIds,
    "Graph release Rust command coverage ids",
  );
  for (const entry of coverage) validateGraphReleaseRustCommandCoverageEntry(entry);
}

export { validateGraphReleaseRustCommandCoverage };

function validateGraphReleaseRustCommandCoverageEntry(entry: GraphReleaseRustCommandCoverage): void {
  validateRequiredObject(entry, "Graph release Rust command coverage entry is required");
  validateGraphReleaseRustCommandId(entry.id);
  validateExactValue(entry.bin, "opcore", `Unknown graph release Rust command bin: ${String(entry.bin)}`);
  validateStringArray(entry.command, "Graph release Rust command coverage command", { allowEmpty: false });
  validateStringArray(entry.canonicalCommand, "Graph release Rust command coverage canonicalCommand", {
    allowEmpty: false,
  });
  validateExactValue(entry.status, "passed", "Graph release Rust command coverage status must be passed");
  validateExactValue(entry.exitCode, 0, "Graph release Rust command coverage exitCode must be 0");
  validateNonEmptyString(entry.fixture, "Graph release Rust command coverage fixture");
  if (typeof entry.durationMs !== "number" || entry.durationMs <= 0) {
    throw new Error("Graph release Rust command coverage durationMs must be positive");
  }
  const route = graphReleaseRouteForRustCommandId(entry.id);
  validateExactValue(entry.bin, route.bin, `Graph release Rust command ${entry.id} must use ${route.bin}`);
  validateExactValue(
    entry.command.join("\0"),
    route.command.join("\0"),
    `Graph release Rust command ${entry.id} route must match ${route.command.join(" ")}`,
  );
  validateExactValue(
    entry.canonicalCommand.join("\0"),
    route.canonicalCommand.join("\0"),
    `Graph release Rust command ${entry.id} route must match ${route.canonicalCommand.join(" ")}`,
  );
}

function validateGraphReleaseDirectSqliteQueries(queries: readonly GraphReleaseDirectSqliteQueryReceipt[]): void {
  validateNonEmptyArray(queries, "Graph release directSqliteQueries");
  validateExactStringSet(
    queries.map((entry) => entry.id),
    graphReleaseDirectSqliteQueryIds,
    "Graph release direct SQLite query ids",
  );
  for (const query of queries) {
    if (!query || typeof query !== "object") throw new Error("Graph release direct SQLite query receipt is required");
    if (!includesString(graphReleaseDirectSqliteQueryIds, query.id)) {
      throw new Error(`Unknown graph release direct SQLite query id: ${String(query.id)}`);
    }
    validateNonEmptyString(query.query, "Graph release direct SQLite query query");
    if (query.status !== "passed") throw new Error("Graph release direct SQLite query status must be passed");
    if (typeof query.rowCount !== "number" || query.rowCount < 0) {
      throw new Error("Graph release direct SQLite query rowCount must be non-negative");
    }
    validateNonEmptyString(query.fixture, "Graph release direct SQLite query fixture");
  }
}

export { validateGraphReleaseDirectSqliteQueries };

function validateGraphReleaseServeTransport(receipts: readonly GraphReleaseServeTransportReceipt[]): void {
  validateNonEmptyArray(receipts, "Graph release serveTransport");
  validateExactStringSet(
    receipts.map((entry) => entry.id),
    graphReleaseServeTransportIds,
    "Graph release serve transport ids",
  );
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") throw new Error("Graph release serve transport receipt is required");
    validateGraphReleaseServeTransportId(receipt.id);
    if (receipt.protocol !== "opcore.graph.daemon") {
      throw new Error("Graph release serve transport protocol must be opcore.graph.daemon");
    }
    validateNonEmptyString(receipt.operation, "Graph release serve transport operation");
    if (receipt.operation !== graphReleaseOperationForServeTransportId(receipt.id)) {
      throw new Error(
        `Graph release serve transport ${receipt.id} operation must be ` +
          graphReleaseOperationForServeTransportId(receipt.id),
      );
    }
    if (receipt.status !== "passed") throw new Error("Graph release serve transport status must be passed");
    if (receipt.exitCode !== 0) throw new Error("Graph release serve transport exitCode must be 0");
  }
}

export { validateGraphReleaseServeTransport };

function validateGraphReleaseBenchmarks(benchmarks: readonly GraphReleaseBenchmarkReceipt[]): void {
  validateNonEmptyArray(benchmarks, "Graph release benchmarks");
  validateExactStringSet(
    benchmarks.map((entry) => entry.metric),
    graphReleaseBenchmarkMetrics,
    "Graph release benchmark metrics",
  );
  for (const benchmark of benchmarks) validateGraphReleaseBenchmark(benchmark);
}

export { validateGraphReleaseBenchmarks };

function validateGraphReleaseBenchmark(benchmark: GraphReleaseBenchmarkReceipt): void {
  validateRequiredObject(benchmark, "Graph release benchmark receipt is required");
  validateGraphReleaseBenchmarkMetric(benchmark.metric);
  if (typeof benchmark.value !== "number" || benchmark.value <= 0) {
    throw new Error("Graph release benchmark value must be positive");
  }
  if (benchmark.unit !== "ms" && benchmark.unit !== "bytes") {
    throw new Error("Graph release benchmark unit must be ms or bytes");
  }
  const expectedUnit = benchmark.metric.endsWith("_bytes") ? "bytes" : "ms";
  validateExactValue(
    benchmark.unit,
    expectedUnit,
    `Graph release benchmark ${benchmark.metric} must use ${expectedUnit}`,
  );
  validateExactValue(benchmark.baselineIssue, "#19", "Graph release benchmark baselineIssue must be #19");
  validateNonEmptyString(benchmark.baselineReceipt, "Graph release benchmark baselineReceipt");
  if (!["recorded", "within_baseline", "above_baseline", "below_baseline"].includes(benchmark.comparison)) {
    throw new Error(`Unknown graph release benchmark comparison: ${String(benchmark.comparison)}`);
  }
}
