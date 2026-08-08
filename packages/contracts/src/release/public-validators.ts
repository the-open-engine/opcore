import { validateRequiredObject } from "../shared/validators-02.js";
import { validateGraphProviderArtifactMetadata } from "../graph/protocol-validators.js";
import {
  validateExactStringSequence,
  validateExactStringSet,
  validateGraphReleaseSourceFreeStrings,
  validateNonEmptyString,
  validateSha256,
} from "../shared/validators-01.js";
import type { AspDogfoodReceipt } from "./asp-contracts-01.js";
import {
  validateAspDogfoodAspHome,
  validateAspDogfoodHostEvaluation,
  validateAspDogfoodHostFixture,
  validateAspDogfoodManager,
  validateAspDogfoodManagerState,
  validateAspDogfoodProvider,
  validateAspDogfoodProviderProbe,
  validateAspDogfoodRepoEnrollment,
} from "./asp-validators-01.js";
import {
  validateAspDogfoodAuthority,
  validateAspDogfoodForbiddenMarkerScan,
  validateAspDogfoodForbiddenProviderEntrypoint,
  validateAspDogfoodParityBlockers,
  validateAspDogfoodUnsupportedSurfaces,
} from "./asp-validators-02.js";
import type { OpcoreSelfValidationReceipt, ReleaseCutoverReceipt } from "./cutover-contracts.js";
import {
  validateReleaseCutoverCommandReceipts,
  validateReleaseCutoverDescriptor,
  validateReleaseCutoverEnvironmentIsolation,
  validateReleaseCutoverInstalledPackages,
} from "./cutover-validators-01.js";
import {
  validateReleaseCutoverForbiddenMarkerScan,
  validateReleaseCutoverInputEvidence,
  validateReleaseCutoverNegativeChecks,
  validateReleaseCutoverPythonCommandReceipts,
  validateReleaseCutoverRustCommandReceipts,
} from "./cutover-validators-02.js";
import type { GraphReleaseReceipt } from "./graph-contracts.js";
import {
  validateGraphReleaseBenchmarks,
  validateGraphReleaseCommandCoverage,
  validateGraphReleaseDirectSqliteQueries,
  validateGraphReleasePackageVersions,
  validateGraphReleaseRustCommandCoverage,
  validateGraphReleaseServeTransport,
} from "./graph-validators-01.js";
import {
  validateGraphReleaseHandoff,
  validateGraphReleaseNativeArtifacts,
  validateGraphReleasePackageInspection,
  validateGraphReleaseReportReceipts,
} from "./graph-validators-02.js";
import { validateGraphReleaseOptionalSurfaces } from "./graph-optional-validators.js";
import { validateReleaseReceiptPackages } from "./graph-validators-03.js";
import { graphReleaseDeferredChildren, graphReleaseRequiredChildren } from "./graph-vocabulary-01.js";
import { graphCoreNativeSupportedTargets } from "./graph-vocabulary-02.js";
import type { ReleaseReceipt } from "./receipt-contracts-02.js";
import { validateReleaseReceiptDescriptor } from "./receipt-validators-01.js";
import {
  validateReleaseReceiptLicense,
  validateReleaseReceiptNativeArtifacts,
  validateReleaseReceiptProvenance,
  validateReleaseReceiptSecretHistory,
} from "./receipt-validators-02.js";
import { validateReleaseReceiptGraphReleaseEvidence, validateReleaseReceiptReports } from "./receipt-validators-03.js";
import { releaseReceiptCommandGroups, releaseReceiptPackageNames } from "./vocabulary-01.js";

function validateGraphReleaseReceipt(receipt: GraphReleaseReceipt): GraphReleaseReceipt {
  validateRequiredObject(receipt, "Graph release receipt is required");
  if (receipt.schemaVersion !== 1) {
    throw new Error("Graph release receipt schemaVersion must be 1");
  }
  if (receipt.issue !== "#17") {
    throw new Error("Graph release receipt issue must be #17");
  }
  if (receipt.origin !== "covibes-authored-synthetic") {
    throw new Error("Graph release receipt origin must be covibes-authored-synthetic");
  }

  validateNonEmptyString(receipt.generatedAt, "Graph release receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "Graph release receipt commitSha");
  if (receipt.graphProviderSchemaVersion !== 1) {
    throw new Error("Graph release receipt graphProviderSchemaVersion must be 1");
  }
  validateGraphReleasePackageVersions(receipt.graphPackageVersions);
  validateExactStringSet(receipt.requiredChildren, graphReleaseRequiredChildren, "Graph release required children");
  validateExactStringSet(receipt.deferredChildren, graphReleaseDeferredChildren, "Graph release deferred children");
  validateGraphReleaseCommandCoverage(receipt.commandCoverage);
  validateGraphReleaseRustCommandCoverage(receipt.rustCommandCoverage);
  validateGraphReleaseDirectSqliteQueries(receipt.directSqliteQueries);
  validateGraphReleaseServeTransport(receipt.serveTransport);
  validateGraphReleaseBenchmarks(receipt.benchmarks);
  validateGraphReleasePackageInspection(receipt.packageInspection);
  validateExactStringSet(
    receipt.supportedNativeTargets,
    graphCoreNativeSupportedTargets,
    "Graph release supported native targets",
  );
  validateGraphReleaseNativeArtifacts(receipt.nativeArtifacts);
  validateGraphReleaseReportReceipts(receipt.reportReceipts);
  validateGraphProviderArtifactMetadata(receipt.graphArtifact);
  validateGraphReleaseOptionalSurfaces(receipt.optionalSurfaces);
  validateGraphReleaseHandoff(receipt.handoff);
  validateGraphReleaseSourceFreeStrings(receipt);

  return receipt;
}

export { validateGraphReleaseReceipt };

function validateReleaseReceipt(receipt: ReleaseReceipt): ReleaseReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("Release receipt is required");
  if (receipt.schemaVersion !== 1) throw new Error("Release receipt schemaVersion must be 1");
  if (receipt.issue !== "#29") throw new Error("Release receipt issue must be #29");
  if (receipt.origin !== "covibes-authored-release-proof") {
    throw new Error("Release receipt origin must be covibes-authored-release-proof");
  }
  validateNonEmptyString(receipt.generatedAt, "Release receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "Release receipt commitSha");
  if (receipt.privateRepo !== true) throw new Error("Release receipt maintainer evidence marker must be true");
  validateExactStringSet(receipt.packageNames, releaseReceiptPackageNames, "Release receipt package names");
  validateExactStringSet(receipt.commandGroups, releaseReceiptCommandGroups, "Release receipt command groups");
  validateReleaseReceiptPackages(receipt.packages);
  validateReleaseReceiptDescriptor(receipt.descriptor, receipt.packages);
  validateReleaseReceiptNativeArtifacts(receipt.nativeArtifacts, receipt.packages, receipt.descriptor);
  validateReleaseReceiptLicense(receipt.license);
  validateReleaseReceiptProvenance(receipt.provenance);
  validateReleaseReceiptSecretHistory(receipt.secretHistory);
  validateReleaseReceiptReports(receipt.reports);
  validateReleaseReceiptGraphReleaseEvidence(receipt.graphReleaseReceipt);
  return receipt;
}

export { validateReleaseReceipt };

const validateOpcoreSelfValidation = (receipt: OpcoreSelfValidationReceipt, label: string): void => {
  if (!receipt || typeof receipt !== "object") throw new Error(`${label} receipt is required`);
  if (receipt.id !== "opcore-self-check") throw new Error(`${label} id must be opcore-self-check`);
  validateExactStringSequence(receipt.command, ["npm", "run", "opcore:self-check"], `${label} command`);
  if (receipt.status !== "passed") throw new Error(`${label} status must be passed`);
  if (receipt.exitCode !== 0) throw new Error(`${label} exitCode must be 0`);
  validateSha256(receipt.stdoutSha256, `${label} stdoutSha256`);
  validateSha256(receipt.stderrSha256, `${label} stderrSha256`);
  validateNonEmptyString(receipt.assertion, `${label} assertion`);
};

export { validateOpcoreSelfValidation };

function validateReleaseCutoverReceipt(receipt: ReleaseCutoverReceipt): ReleaseCutoverReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("Release cutover receipt is required");
  if (receipt.schemaVersion !== 1) throw new Error("Release cutover receipt schemaVersion must be 1");
  if (receipt.issue !== "#30") throw new Error("Release cutover receipt issue must be #30");
  if (receipt.origin !== "covibes-authored-cutover-proof") {
    throw new Error("Release cutover receipt origin must be covibes-authored-cutover-proof");
  }
  validateNonEmptyString(receipt.generatedAt, "Release cutover receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "Release cutover receipt commitSha");
  if (receipt.privateRepo !== true) throw new Error("Release cutover receipt maintainer evidence marker must be true");
  validateExactStringSet(receipt.packageNames, releaseReceiptPackageNames, "Release cutover receipt package names");
  validateReleaseCutoverInstalledPackages(receipt.installedPackages);
  validateReleaseCutoverDescriptor(receipt.descriptor);
  validateReleaseCutoverEnvironmentIsolation(receipt.environmentIsolation);
  validateReleaseCutoverCommandReceipts(receipt.commandReceipts);
  validateReleaseCutoverRustCommandReceipts(receipt.rustCommandReceipts);
  validateReleaseCutoverPythonCommandReceipts(receipt.pythonCommandReceipts);
  validateReleaseCutoverNegativeChecks(receipt.negativeChecks);
  validateOpcoreSelfValidation(receipt.selfValidation, "Release cutover self-validation");
  validateReleaseCutoverForbiddenMarkerScan(receipt.forbiddenMarkerScan);
  validateReleaseCutoverInputEvidence(receipt.inputEvidence);
  return receipt;
}

export { validateReleaseCutoverReceipt };

function validateAspDogfoodReceipt(receipt: AspDogfoodReceipt): AspDogfoodReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("ASP dogfood receipt is required");
  if (receipt.schemaVersion !== 1) throw new Error("ASP dogfood receipt schemaVersion must be 1");
  if (receipt.issue !== "#120") throw new Error("ASP dogfood receipt issue must be #120");
  if (receipt.origin !== "covibes-authored-asp-dogfood-proof") {
    throw new Error("ASP dogfood receipt origin must be covibes-authored-asp-dogfood-proof");
  }
  validateNonEmptyString(receipt.generatedAt, "ASP dogfood receipt generatedAt");
  validateNonEmptyString(receipt.commitSha, "ASP dogfood receipt commitSha");
  if (receipt.privateRepo !== true) throw new Error("ASP dogfood receipt privateRepo must be true");
  if (receipt.bootstrapSource !== "local-sibling") throw new Error("ASP dogfood bootstrapSource must be local-sibling");
  validateExactStringSet(receipt.packageNames, releaseReceiptPackageNames, "ASP dogfood receipt package names");
  validateReleaseCutoverInstalledPackages(receipt.installedPackages);
  validateAspDogfoodManager(receipt.manager);
  validateAspDogfoodAspHome(receipt.aspHome);
  validateAspDogfoodHostFixture(receipt.hostFixture);
  validateAspDogfoodProvider(receipt.provider);
  validateAspDogfoodManagerState(receipt.managerState);
  validateAspDogfoodRepoEnrollment(receipt.repoEnrollment);
  validateAspDogfoodHostEvaluation(receipt.hostEvaluation);
  validateAspDogfoodProviderProbe(receipt.providerProbe);
  validateOpcoreSelfValidation(receipt.selfValidation, "ASP dogfood self-validation");
  validateAspDogfoodUnsupportedSurfaces(receipt.unsupportedSurfaces);
  validateAspDogfoodParityBlockers(receipt.parityBlockers);
  validateAspDogfoodAuthority(receipt.authority);
  if (!Array.isArray(receipt.publicReleaseActions) || receipt.publicReleaseActions.length !== 0) {
    throw new Error("ASP dogfood receipt must not record public publish, registry, or standard-readiness actions");
  }
  validateAspDogfoodForbiddenMarkerScan(receipt.forbiddenMarkerScan);
  validateAspDogfoodForbiddenProviderEntrypoint(receipt);
  return receipt;
}

export { validateAspDogfoodReceipt };
