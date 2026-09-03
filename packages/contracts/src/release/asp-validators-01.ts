import { validateRequiredObject } from "../shared/validators-02.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateExactStringSequence,
  validateExactStringSet,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateSha256,
  validateStringArray,
} from "../shared/validators-01.js";
import type {
  AspDogfoodAspHomeEvidence,
  AspDogfoodHostEvaluationEvidence,
  AspDogfoodHostFixtureEvidence,
  AspDogfoodManagerEvidence,
  AspDogfoodManagerStateEvidence,
  AspDogfoodProviderEvidence,
  AspDogfoodProviderManifestEvidence,
  AspDogfoodProviderProbeEvidence,
  AspDogfoodRepoEnrollmentEvidence,
} from "./asp-contracts-01.js";
import {
  assertNoAspDogfoodHostOwnedFields,
  validateAspDogfoodCommandRun,
  validateAspDogfoodPassedCommandRun,
} from "./asp-validators-02.js";

function validateAspDogfoodManager(manager: AspDogfoodManagerEvidence): void {
  if (!manager || typeof manager !== "object") throw new Error("ASP dogfood manager evidence is required");
  if (manager.bootstrapSource !== "local-sibling") throw new Error("ASP dogfood bootstrapSource must be local-sibling");
  validateNonEmptyString(manager.aspRepoPath, "ASP dogfood manager aspRepoPath");
  validateNonEmptyString(manager.aspBinPath, "ASP dogfood manager aspBinPath");
  validateNonEmptyString(manager.cliPath, "ASP dogfood manager cliPath");
  validateNonEmptyString(manager.commitSha, "ASP dogfood manager commitSha");
}

export { validateAspDogfoodManager };

function validateAspDogfoodAspHome(aspHome: AspDogfoodAspHomeEvidence): void {
  if (!aspHome || typeof aspHome !== "object") throw new Error("ASP dogfood ASP_HOME evidence is required");
  validateNonEmptyString(aspHome.path, "ASP dogfood ASP_HOME path");
  if (aspHome.temp !== true) throw new Error("ASP dogfood ASP_HOME must be temporary");
  if (aspHome.isolated !== true) throw new Error("ASP dogfood ASP_HOME must be isolated");
  if (aspHome.sharedStateMutated !== false) throw new Error("ASP dogfood shared ASP state must not be mutated");
  if (aspHome.pathSanitized !== true) throw new Error("ASP dogfood PATH must be sanitized for manager execution");
}

export { validateAspDogfoodAspHome };

function validateAspDogfoodHostFixture(fixture: AspDogfoodHostFixtureEvidence): void {
  if (!fixture || typeof fixture !== "object") throw new Error("ASP dogfood host fixture evidence is required");
  validateNonEmptyString(fixture.repo, "ASP dogfood host fixture repo");
  if (fixture.temp !== true) throw new Error("ASP dogfood host fixture repo must be temporary");
  if (fixture.sourceRepoMutated !== false) throw new Error("ASP dogfood host fixture must not mutate the source repo");
  if (fixture.baselineCommitted !== true) throw new Error("ASP dogfood host fixture must commit a baseline");
  validateStringArray(fixture.changedPaths, "ASP dogfood host fixture changedPaths", { allowEmpty: false });
  for (const path of fixture.changedPaths) validateRepoRelativePath(path);
}

export { validateAspDogfoodHostFixture };

function validateAspDogfoodProvider(provider: AspDogfoodProviderEvidence): void {
  if (!provider || typeof provider !== "object") throw new Error("ASP dogfood provider evidence is required");
  if (provider.providerId !== "opcore") throw new Error("ASP dogfood providerId must be opcore");
  if (provider.packageName !== "opcore") {
    throw new Error("ASP dogfood provider package must be opcore");
  }
  validateNonEmptyString(provider.binPath, "ASP dogfood provider binPath");
  if (!provider.binPath.endsWith("node_modules/.bin/opcore-asp-provider")) {
    throw new Error("ASP dogfood provider binPath must use installed node_modules/.bin/opcore-asp-provider");
  }
  validateNonEmptyString(provider.indexPath, "ASP dogfood provider indexPath");
  if (
    !provider.indexPath.endsWith("node_modules/opcore/node_modules/@the-open-engine/opcore-asp-provider/dist/index.js")
  ) {
    throw new Error("ASP dogfood provider indexPath must be bundled opcore-asp-provider dist/index.js");
  }
  validateSha256(provider.indexSha256, "ASP dogfood provider indexSha256");
  validateExactStringSequence(provider.command, ["opcore-asp-provider", "--stdio"], "ASP dogfood provider command");
  if (!provider.entrypoint || typeof provider.entrypoint !== "object")
    throw new Error("ASP dogfood provider entrypoint is required");
  if (provider.entrypoint.transport !== "stdio")
    throw new Error("ASP dogfood provider entrypoint transport must be stdio");
  validateAspDogfoodProviderBinPath(provider.entrypoint.bin, "ASP dogfood provider entrypoint bin");
  validateExactStringSequence(provider.entrypoint.args, ["--stdio"], "ASP dogfood provider entrypoint args");
  validateAspDogfoodProviderManifest(provider.manifest);
}

export { validateAspDogfoodProvider };

function validateAspDogfoodProviderManifest(manifestEvidence: AspDogfoodProviderManifestEvidence): void {
  if (!manifestEvidence || typeof manifestEvidence !== "object")
    throw new Error("ASP dogfood provider manifest evidence is required");
  validateNonEmptyString(manifestEvidence.manifestPath, "ASP dogfood provider manifestPath");
  validateSha256(manifestEvidence.manifestSha256, "ASP dogfood provider manifestSha256");
  validateRequiredObject(manifestEvidence.manifest, "ASP dogfood provider manifest must be structured metadata");
  const manifest = manifestEvidence.manifest as Record<string, unknown>;
  if (manifest.manifestVersion !== "asp-server/0.1")
    throw new Error("ASP dogfood provider manifestVersion must be asp-server/0.1");
  const server = manifest.server as Record<string, unknown> | undefined;
  if (!server || server.id !== "opcore") throw new Error("ASP dogfood provider manifest server.id must be opcore");
  const entrypoint = manifest.entrypoint as Record<string, unknown> | undefined;
  if (!entrypoint || entrypoint.transport !== "stdio" || typeof entrypoint.bin !== "string") {
    throw new Error("ASP dogfood provider manifest entrypoint must be opcore-asp-provider --stdio");
  }
  validateAspDogfoodProviderBinPath(entrypoint.bin, "ASP dogfood provider manifest entrypoint bin");
  validateExactStringSequence(
    entrypoint.args as readonly string[],
    ["--stdio"],
    "ASP dogfood provider manifest entrypoint args",
  );
  const capabilities = manifest.capabilities;
  if (!Array.isArray(capabilities)) {
    throw new Error("ASP dogfood provider manifest capabilities must be an array");
  }
  validateExactStringSet(
    capabilities,
    ["check"],
    "ASP dogfood provider manifest capabilities",
  );
}

export { validateAspDogfoodProviderManifest };

function validateAspDogfoodProviderBinPath(value: unknown, label: string): void {
  validateNonEmptyString(value, label);
  const normalized = String(value).replaceAll("\\", "/");
  if (!/node_modules\/\.bin\/opcore-asp-provider(?:\.cmd)?$/.test(normalized)) {
    throw new Error(`${label} must use installed node_modules/.bin/opcore-asp-provider`);
  }
}

export { validateAspDogfoodProviderBinPath };

function validateAspDogfoodManagerState(state: AspDogfoodManagerStateEvidence): void {
  if (!state || typeof state !== "object") throw new Error("ASP dogfood managerState is required");
  validateAspDogfoodPassedCommandRun(state.status, "asp-status", "ASP dogfood manager status");
  validateAspDogfoodPassedCommandRun(state.serverAdd, "asp-server-add", "ASP dogfood manager server add");
  validateAspDogfoodPassedCommandRun(state.serverStatus, "asp-server-status", "ASP dogfood manager server status");
  validateRequiredObject(state.serverStatus.output, "ASP dogfood server status output is required");
}

export { validateAspDogfoodManagerState };

function validateAspDogfoodRepoEnrollment(enrollment: AspDogfoodRepoEnrollmentEvidence): void {
  if (!enrollment || typeof enrollment !== "object") throw new Error("ASP dogfood repo enrollment is required");
  validateNonEmptyString(enrollment.repo, "ASP dogfood repo enrollment repo");
  if (enrollment.mode !== "advisory" && enrollment.mode !== "shadow") {
    throw new Error("ASP dogfood repo enrollment mode must be advisory or shadow");
  }
  validateAspDogfoodPassedCommandRun(enrollment.repoAdd, "asp-repo-add", "ASP dogfood repo add");
  validateAspDogfoodPassedCommandRun(enrollment.repoEnable, "asp-repo-enable", "ASP dogfood repo enable");
  validateAspDogfoodPassedCommandRun(enrollment.repoStatus, "asp-repo-status", "ASP dogfood repo status");
}

export { validateAspDogfoodRepoEnrollment };

function validateAspDogfoodHostEvaluation(evaluation: AspDogfoodHostEvaluationEvidence): void {
  if (!evaluation || typeof evaluation !== "object") throw new Error("ASP dogfood host evaluation is required");
  validateAspDogfoodPassedCommandRun(evaluation.check, "asp-check-changed", "ASP dogfood host check");
  if (!evaluation.check.command.includes("check")) throw new Error("ASP dogfood host check must run asp check");
  validateRequiredObject(evaluation.check.hostDecision, "ASP dogfood host decision is required");
  validateRequiredObject(evaluation.check.receipt, "ASP dogfood host receipt is required");
  validateAspDogfoodHostAuthorityEvidence(evaluation.check.hostDecision, "ASP dogfood host decision", {
    requireProviderProvenance: false,
  });
  validateAspDogfoodHostAuthorityEvidence(evaluation.check.receipt, "ASP dogfood host receipt", {
    requireProviderProvenance: true,
  });
  validateRequiredObject(evaluation.check.assurance, "ASP dogfood host assurance is required");
  validateNonEmptyString(evaluation.check.assurance.mode, "ASP dogfood host assurance mode");
  validateNonEmptyString(evaluation.check.assurance.transactionGuarantee, "ASP dogfood host transactionGuarantee");
  if (evaluation.ciVerify !== undefined) {
    validateAspDogfoodCommandRun(evaluation.ciVerify, "asp-ci-verify", "ASP dogfood CI verify");
    if (!evaluation.ciVerify.command.includes("ci") || !evaluation.ciVerify.command.includes("verify")) {
      throw new Error("ASP dogfood CI verifier must run asp ci verify");
    }
  }
}

export { validateAspDogfoodHostEvaluation };

function validateAspDogfoodHostAuthorityEvidence(
  value: unknown,
  label: string,
  options: { requireProviderProvenance: boolean },
): void {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
  const record = value as Record<string, unknown>;
  const authorityEvidence = record.authorityEvidence;
  if (!Array.isArray(authorityEvidence) || authorityEvidence.length === 0) {
    throw new Error(`${label} must include host authorityEvidence`);
  }
  const providerProvenance = record.providerProvenance;
  if (options.requireProviderProvenance && (!Array.isArray(providerProvenance) || providerProvenance.length === 0)) {
    throw new Error(`${label} must include providerProvenance`);
  }
}

export { validateAspDogfoodHostAuthorityEvidence };

function validateAspDogfoodProviderProbe(probe: AspDogfoodProviderProbeEvidence): void {
  if (!probe || typeof probe !== "object") throw new Error("ASP dogfood provider probe is required");
  validateAspDogfoodPassedCommandRun(probe, "provider-probe", "ASP dogfood provider probe");
  validateExactStringSequence(probe.command, ["opcore-asp-provider", "--stdio"], "ASP dogfood provider probe command");
  if (!probe.assessment || typeof probe.assessment !== "object")
    throw new Error("ASP dogfood provider probe assessment is required");
  if (!probe.validAsOf || typeof probe.validAsOf !== "object")
    throw new Error("ASP dogfood provider probe validAsOf is required");
  if (!probe.coverage || typeof probe.coverage !== "object")
    throw new Error("ASP dogfood provider probe coverage is required");
  validateNonNegativeInteger(probe.diagnosticsCount, "ASP dogfood provider probe diagnosticsCount");
  if (probe.hostOwnedFieldLeak !== false)
    throw new Error("ASP dogfood provider output must not contain host-owned decision fields");
  assertNoAspDogfoodHostOwnedFields(probe.assessment);
}

export { validateAspDogfoodProviderProbe };
