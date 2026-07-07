import {
  aspDogfoodForbiddenProviderMarkers,
  graphCoreNativePackageNameForTarget,
  graphCoreNativeSupportedTargets,
  releaseReceiptPackageNames
} from "../../packages/contracts/dist/index.js";

export function validAspDogfoodReceipt() {
  const hostDecision = hostDecisionFixture();
  return {
    ...receiptHeader(),
    packageNames: releaseReceiptPackageNames,
    installedPackages: installedPackagesFixture(),
    manager: managerFixture(),
    aspHome: aspHomeFixture(),
    hostFixture: hostFixtureFixture(),
    provider: providerFixture(),
    managerState: managerStateFixture(),
    repoEnrollment: repoEnrollmentFixture(),
    hostEvaluation: hostEvaluationFixture(hostDecision),
    providerProbe: providerProbeFixture(),
    currentToolGuardrails: guardrailsFixture(),
    unsupportedSurfaces: unsupportedSurfacesFixture(),
    parityBlockers: [{ source: "docs/planning/old-tool-compatibility-matrix.md:1", detail: "old-tool guardrails retained" }],
    authority: authorityFixture(),
    publicReleaseActions: [],
    oldToolReplacementClaimed: false,
    forbiddenMarkerScan: { scannedTextCount: 2, findingCount: 0, markersBlocked: aspDogfoodForbiddenProviderMarkers }
  };
}

export function invalidAspDogfoodCases(receipt) {
  return [
    ["opcore asp serve entrypoint", { ...receipt, provider: { ...receipt.provider, command: ["opcore", "asp", "serve"] } }, /provider command/],
    ["ACE runtime provider entrypoint", { ...receipt, provider: { ...receipt.provider, binPath: ".ace/runtime/bin/opcore-asp-provider" } }, /node_modules\/\.bin\/opcore-asp-provider|forbidden marker/],
    ["failed ASP server add", failedManagerServerAdd(receipt), /manager server add status must be passed/],
    ["failed ASP repo enable", failedRepoEnable(receipt), /repo enable status must be passed/],
    ["failed ASP host check", failedHostCheck(receipt), /host check status must be passed/],
    ["missing host fixture evidence", missingHostFixture(receipt), /host fixture evidence/],
    ["host fixture mutates source repo", sourceMutatingHostFixture(receipt), /source repo/],
    ["failed provider probe", failedProviderProbe(receipt), /provider probe status must be passed/],
    ["failed required old-tool guardrail", failedRequiredGuardrail(receipt), /required guardrail current-tools-validate-changed must pass/],
    ["missing host receipt authority evidence", missingHostAuthority(receipt), /authorityEvidence/],
    ["provider output as host decision", providerDecisionLeak(receipt), /host-owned field|host-owned decision|hostOwnedFieldLeak/],
    ["missing old-tool guardrail", missingGuardrail(receipt), /guardrail ids/],
    ["unsupported inspect clean coverage", cleanInspectCoverage(receipt), /clean coverage/],
    ["silent local authority weakening", weakenedAuthority(receipt), /weaken shared authority/],
    ["public publish action", { ...receipt, publicReleaseActions: [{ action: "publish" }] }, /public publish/],
    ["old-tool replacement claim", { ...receipt, oldToolReplacementClaimed: true }, /old-tool replacement/]
  ];
}

function receiptHeader() {
  return {
    schemaVersion: 1,
    issue: "#120",
    origin: "covibes-authored-asp-dogfood-proof",
    generatedAt: "2026-06-24T00:00:00.000Z",
    commitSha: "a".repeat(40),
    privateRepo: true,
    bootstrapSource: "local-sibling"
  };
}

function installedPackagesFixture() {
  return releaseReceiptPackageNames
    .map((packageName) => ({
    packageName,
    version: "0.1.0",
    tarball: { filename: `${packageName.split("/").pop()}-0.1.0.tgz`, sha256: "1".repeat(64) },
    installedManifest: { path: `node_modules/${packageName}/package.json`, sha256: "2".repeat(64), bins: binsFor(packageName) },
    installedFiles: installedFilesFor(packageName)
  }));
}

function binsFor(packageName) {
  if (packageName === "opcore") return { opcore: "dist/index.js", "opcore-asp-provider": "dist/asp-provider-bin.js" };
  return {};
}

function installedFilesFor(packageName) {
  const paths = [
    "package.json",
    ...(packageName === "opcore"
      ? [
          "dist/index.js",
          "dist/asp-provider-bin.js",
          "node_modules/@the-open-engine/opcore-asp-provider/dist/index.js",
          "node_modules/@the-open-engine/opcore-asp-provider/dist/manifests/asp-server.json",
          ...graphCoreNativeSupportedTargets.map((target) =>
            `node_modules/${graphCoreNativePackageNameForTarget(target)}/opcore-graph-core`
          )
        ]
      : [])
  ];
  return paths.map((path) => ({ path: `node_modules/${packageName}/${path}`, sha256: "3".repeat(64) }));
}

function managerFixture() {
  const repo = covibesPath("agent-server-protocol");
  return {
    bootstrapSource: "local-sibling",
    aspRepoPath: repo,
    aspBinPath: `${repo}/packages/asp/bin/asp`,
    cliPath: `${repo}/packages/asp/dist/cli.js`,
    commitSha: "b".repeat(40)
  };
}

function aspHomeFixture() {
  return {
    path: "/tmp/opcore-asp-dogfood/asp-home",
    temp: true,
    isolated: true,
    sharedStateMutated: false,
    pathSanitized: true,
    aceRuntimeBinExcluded: true
  };
}

function hostFixtureFixture() {
  return {
    repo: "/tmp/opcore-asp-dogfood/asp-host-fixture",
    temp: true,
    sourceRepoMutated: false,
    baselineCommitted: true,
    changedPaths: ["src/dogfood.ts"]
  };
}

function providerFixture() {
  return {
    providerId: "opcore",
    packageName: "opcore",
    binPath: "node_modules/.bin/opcore-asp-provider",
    indexPath: "node_modules/opcore/node_modules/@the-open-engine/opcore-asp-provider/dist/index.js",
    indexSha256: "e".repeat(64),
    command: ["opcore-asp-provider", "--stdio"],
    entrypoint: { transport: "stdio", bin: "/tmp/opcore-asp-dogfood/project/node_modules/.bin/opcore-asp-provider", args: ["--stdio"] },
    manifest: { manifestPath: "/tmp/opcore-asp-dogfood/asp-server.opcore.json", manifestSha256: "f".repeat(64), manifest: serverManifestFixture() }
  };
}

function serverManifestFixture() {
  return {
    manifestVersion: "asp-server/0.1",
    server: { id: "opcore", name: "Opcore", version: "0.1.0" },
    protocolVersions: ["asp/0.1"],
    capabilities: ["check"],
    capabilityProfiles: ["core-check-provider", "opcore-core-check"],
    entrypoint: { transport: "stdio", bin: "/tmp/opcore-asp-dogfood/project/node_modules/.bin/opcore-asp-provider", args: ["--stdio"] },
    artifact: { fingerprint: `sha256:${"e".repeat(64)}`, checksums: [{ path: "dist/index.js", sha256: "e".repeat(64) }] },
    provenance: { publisher: "the-open-engine", source: "https://github.com/the-open-engine/opcore", license: "MIT" },
    accessExpectations: accessExpectationsFixture()
  };
}

function accessExpectationsFixture() {
  return {
    filesystem: { read: ["workspace:snapshot"], write: [] },
    network: { outbound: false, allowlist: [] },
    secrets: { names: [] },
    environment: { inherit: false, variables: ["ASP_SESSION_ID", "PATH"] },
    dataClasses: ["source-code", "diff-metadata"]
  };
}

function managerStateFixture() {
  return {
    status: command("asp-status", ["asp", "status", "--json"]),
    serverAdd: command("asp-server-add", ["asp", "server", "add", "--manifest", "/tmp/asp-server.opcore.json", "--json"]),
    serverStatus: command("asp-server-status", ["asp", "server", "status", "opcore", "--json"])
  };
}

function repoEnrollmentFixture() {
  const repo = hostFixtureFixture().repo;
  return {
    repo,
    mode: "advisory",
    repoAdd: command("asp-repo-add", ["asp", "repo", "add", repo, "--json"]),
    repoEnable: command("asp-repo-enable", ["asp", "repo", "enable", "opcore", "--repo", repo, "--mode", "advisory", "--json"]),
    repoStatus: command("asp-repo-status", ["asp", "repo", "status", repo, "--json"])
  };
}

function hostEvaluationFixture(hostDecision) {
  const repo = hostFixtureFixture().repo;
  return {
    check: {
      ...command("asp-check-changed", ["asp", "check", "--repo", repo, "--changed", "--call-site", "interactive", "--json"]),
      hostDecision,
      receipt: hostDecision.receipt,
      assurance: { mode: "gated", transactionGuarantee: "none" }
    },
    ciVerify: command("asp-ci-verify", ["asp", "ci", "verify", "--repo", repo, "--changed-from", "main", "--json"])
  };
}

function hostDecisionFixture() {
  return {
    decision: "allow",
    receipt: { receiptId: "core-evaluate-allow-test", authorityEvidence: [{ identity: "opcore" }], providerProvenance: [{ provider: "opcore", capability: "check" }], assurance: { mode: "gated", transactionGuarantee: "none" } },
    authorityEvidence: [{ identity: "opcore" }],
    providerProvenance: [{ provider: "opcore", capability: "check" }],
    assurance: { mode: "gated", transactionGuarantee: "none" }
  };
}

function providerProbeFixture() {
  return {
    ...command("provider-probe", ["opcore-asp-provider", "--stdio"]),
    assessment: assessmentFixture(),
    validAsOf: { baseline: { rev: "tree:test" }, changesetDigest: "sha256:test", blobs: [] },
    coverage: { degraded: [], unsupported: [], exhaustive: false },
    diagnosticsCount: 0,
    hostOwnedFieldLeak: false
  };
}

function assessmentFixture() {
  return {
    status: "complete",
    diagnostics: [],
    coverage: { degraded: [], unsupported: [], exhaustive: false },
    validAsOf: { baseline: { rev: "tree:test" }, changesetDigest: "sha256:test", blobs: [] },
    provider: { id: "opcore", capabilityFamily: "check" }
  };
}

function guardrailsFixture() {
  return [
    { ...command("current-tools-validate-changed", ["npm", "run", "current-tools:validate-changed"]), retained: true },
    { ...command("current-tools-validate-rust-graph", ["npm", "run", "current-tools:validate-rust-graph"]), retained: true },
    { id: "current-tools-validate-all", command: ["npm", "run", "current-tools:validate-all"], status: "retained-not-run", exitCode: null, stdoutSha256: "0".repeat(64), stderrSha256: "0".repeat(64), retained: true, assertion: "retained by default" }
  ];
}

function unsupportedSurfacesFixture() {
  return [
    { surface: "inspect", status: "parity-blocker", cleanCoverage: false, blocker: "inspect not mapped into ASP #120" },
    { surface: "edit", status: "retained-old-tool-gate", cleanCoverage: false, blocker: "edit not mapped into ASP #120" }
  ];
}

function authorityFixture() {
  return {
    hostOwnsDecisions: true,
    providerOutputIsHostDecision: false,
    localAuthorityOverride: { present: false, sharedAuthorityWeakened: false }
  };
}

function command(id, commandParts, output = {}) {
  return {
    id,
    command: commandParts,
    status: "passed",
    exitCode: 0,
    stdoutSha256: "c".repeat(64),
    stderrSha256: "d".repeat(64),
    output,
    assertion: `${id} passed`
  };
}

function failedCommand(entry) {
  return { ...entry, status: "failed", exitCode: 1, assertion: `${entry.id} failed` };
}

function failedManagerServerAdd(receipt) {
  return { ...receipt, managerState: { ...receipt.managerState, serverAdd: failedCommand(receipt.managerState.serverAdd) } };
}

function failedRepoEnable(receipt) {
  return { ...receipt, repoEnrollment: { ...receipt.repoEnrollment, repoEnable: failedCommand(receipt.repoEnrollment.repoEnable) } };
}

function failedHostCheck(receipt) {
  return {
    ...receipt,
    hostEvaluation: {
      ...receipt.hostEvaluation,
      check: failedCommand(receipt.hostEvaluation.check)
    }
  };
}

function missingHostFixture(receipt) {
  const { hostFixture, ...withoutHostFixture } = receipt;
  void hostFixture;
  return withoutHostFixture;
}

function sourceMutatingHostFixture(receipt) {
  return { ...receipt, hostFixture: { ...receipt.hostFixture, sourceRepoMutated: true } };
}

function failedProviderProbe(receipt) {
  return { ...receipt, providerProbe: failedCommand(receipt.providerProbe) };
}

function failedRequiredGuardrail(receipt) {
  return {
    ...receipt,
    currentToolGuardrails: receipt.currentToolGuardrails.map((entry) =>
      entry.id === "current-tools-validate-changed" ? failedCommand(entry) : entry
    )
  };
}

function missingHostAuthority(receipt) {
  return { ...receipt, hostEvaluation: { ...receipt.hostEvaluation, check: { ...receipt.hostEvaluation.check, receipt: { ...receipt.hostEvaluation.check.receipt, authorityEvidence: [] } } } };
}

function providerDecisionLeak(receipt) {
  return { ...receipt, providerProbe: { ...receipt.providerProbe, assessment: { ...receipt.providerProbe.assessment, decision: "allow" }, hostOwnedFieldLeak: true } };
}

function missingGuardrail(receipt) {
  return { ...receipt, currentToolGuardrails: receipt.currentToolGuardrails.filter((entry) => entry.id !== "current-tools-validate-changed") };
}

function cleanInspectCoverage(receipt) {
  return { ...receipt, unsupportedSurfaces: receipt.unsupportedSurfaces.map((entry) => entry.surface === "inspect" ? { ...entry, cleanCoverage: true } : entry) };
}

function weakenedAuthority(receipt) {
  return { ...receipt, authority: { ...receipt.authority, localAuthorityOverride: { present: true, sharedAuthorityWeakened: true } } };
}

function covibesPath(repo) {
  return `${["", "Users", "tom", "code", "covibes"].join("/")}/${repo}`;
}
