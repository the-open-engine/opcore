import { validateRequiredObject } from "../shared/validators-02.js";
import type { CommandRouterManifest } from "../command/contracts.js";
import {
  validateCommandRouterManifestHeader,
  validateManifestBins,
  validateManifestGroups,
  validateManifestOwnershipBoundaries,
} from "../command/validators.js";
import { includesString, sameStringArray } from "../shared/primitives.js";
import { validateGraphReleaseOptionalSurfaces } from "../release/graph-optional-validators.js";
import {
  validateCommandExitSemantics,
  validateExactStringSequence,
  validateExactStringSet,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateStringArray,
} from "../shared/validators-01.js";
import type {
  ManagedToolDescriptor,
  ManagedToolDescriptorCapabilities,
  ManagedToolDescriptorCommandGroup,
  ManagedToolDescriptorEntrypoint,
  ManagedToolDescriptorHealthProbe} from "./contracts.js";
import {
  managedToolDescriptorCommandGroupPackageNames,
  managedToolDescriptorCommandGroups,
} from "./contracts.js";
import {
  validateManagedToolEditCapabilities,
  validateManagedToolGraphCapabilities,
  validateManagedToolValidationCapabilities,
} from "./validators-02.js";
import {
  validateManagedToolArtifacts,
  validateManagedToolChecksums,
  validateManagedToolCommandTokens,
  validateManagedToolDescriptorForbiddenStrings,
  validateManagedToolPackagePath,
  validateManagedToolProvenanceHooks,
} from "./validators-03.js";

function validateCommandRouterManifest(manifest: CommandRouterManifest): CommandRouterManifest {
  validateCommandRouterManifestHeader(manifest);
  validateManifestBins(manifest.bins);
  validateCommandExitSemantics(manifest.exitSemantics);

  validateManifestGroups(manifest.commandGroups);
  validateManifestOwnershipBoundaries(manifest.ownershipBoundaries);

  return manifest;
}

export { validateCommandRouterManifest };

function validateManagedToolDescriptor(descriptor: ManagedToolDescriptor): ManagedToolDescriptor {
  validateRequiredObject(descriptor, "Managed tool descriptor is required");
  if (descriptor.schemaVersion !== 1) throw new Error("Managed tool descriptor schemaVersion must be 1");
  if (descriptor.descriptorKind !== "aggregate_opcore") {
    throw new Error("Managed tool descriptor descriptorKind must be aggregate_opcore");
  }
  validateManagedToolIdentity(descriptor);
  validateManagedToolEntrypoints(descriptor.entrypoints);
  validateManagedToolCommandGroups(descriptor.commandGroups);
  validateManagedToolHealthProbes(descriptor.healthProbes);
  validateManagedToolCapabilities(descriptor.capabilities);
  const artifactReferences = validateManagedToolArtifacts(descriptor.artifacts);
  validateManagedToolChecksums(descriptor.checksums, artifactReferences);
  validateManagedToolProvenanceHooks(descriptor.provenanceHooks);
  validateGraphReleaseOptionalSurfaces(descriptor.optionalSurfaces);
  validateManagedToolDescriptorForbiddenStrings(descriptor);
  return descriptor;
}

export { validateManagedToolDescriptor };

function validateManagedToolIdentity(descriptor: ManagedToolDescriptor): void {
  const aggregate = descriptor.aggregateIdentity;
  if (!aggregate || typeof aggregate !== "object")
    throw new Error("Managed tool descriptor aggregateIdentity is required");
  if (aggregate.name !== "opcore") throw new Error("Managed tool descriptor aggregateIdentity.name must be opcore");
  if (aggregate.releaseLine !== "opcore")
    throw new Error("Managed tool descriptor aggregateIdentity.releaseLine must be opcore");
  if (aggregate.packageName !== "opcore") {
    throw new Error("Managed tool descriptor aggregateIdentity.packageName must be opcore");
  }
  if (aggregate.version !== undefined)
    validateNonEmptyString(aggregate.version, "Managed tool descriptor aggregateIdentity.version");

  const packageIdentity = descriptor.packageIdentity;
  validateRequiredObject(packageIdentity, "Managed tool descriptor packageIdentity is required");
  if (packageIdentity.packageName !== "opcore") {
    throw new Error("Managed tool descriptor packageIdentity.packageName must be opcore");
  }
  if (packageIdentity.artifactName !== "opcore") {
    throw new Error("Managed tool descriptor packageIdentity.artifactName must be opcore");
  }
  if (packageIdentity.version !== undefined)
    validateNonEmptyString(packageIdentity.version, "Managed tool descriptor packageIdentity.version");
}

export { validateManagedToolIdentity };

function validateManagedToolEntrypoints(entrypoints: readonly ManagedToolDescriptorEntrypoint[]): void {
  validateNonEmptyArray(entrypoints, "Managed tool descriptor entrypoints");
  validateExactStringSet(
    entrypoints.map((entrypoint) => entrypoint.bin),
    ["opcore"],
    "Managed tool descriptor entrypoint bins",
  );
  for (const entrypoint of entrypoints) {
    if (!entrypoint || typeof entrypoint !== "object")
      throw new Error("Managed tool descriptor entrypoint is required");
    if (entrypoint.bin !== "opcore") throw new Error("Managed tool descriptor must expose the opcore entrypoint");
    if (entrypoint.packageName !== "opcore") {
      throw new Error("Managed tool descriptor entrypoint packageName must be opcore");
    }
    validateManagedToolPackagePath(entrypoint.path, "Managed tool descriptor entrypoint path");
    if (entrypoint.path !== "dist/index.js") {
      throw new Error("Managed tool descriptor entrypoint path must be dist/index.js");
    }
    validateExactStringSequence(entrypoint.command, ["opcore"], "Managed tool descriptor entrypoint command");
  }
}

export { validateManagedToolEntrypoints };

function validateManagedToolCommandGroups(commandGroups: readonly ManagedToolDescriptorCommandGroup[]): void {
  validateNonEmptyArray(commandGroups, "Managed tool descriptor command groups");
  validateExactStringSet(
    commandGroups.map((group) => group.name),
    managedToolDescriptorCommandGroups,
    "Managed tool descriptor command groups",
  );
  for (const group of commandGroups) {
    if (!group || typeof group !== "object") throw new Error("Managed tool descriptor command group is required");
    if (!includesString(managedToolDescriptorCommandGroups, group.name)) {
      throw new Error(`Unknown managed tool descriptor command group: ${String(group.name)}`);
    }
    const expectedCanonical = ["opcore", group.name];
    validateExactStringSequence(
      group.canonicalCommand,
      expectedCanonical,
      `Managed tool descriptor ${group.name} canonicalCommand`,
    );
    validateStringArray(group.commands, `Managed tool descriptor ${group.name} commands`, { allowEmpty: false });
    const expectedPackageName = managedToolDescriptorCommandGroupPackageNames[group.name];
    if (group.packageName !== expectedPackageName) {
      throw new Error(`Managed tool descriptor ${group.name} packageName must be ${expectedPackageName}`);
    }
    validateManagedToolCommandTokens(group.commands, `Managed tool descriptor ${group.name} commands`);
  }
}

export { validateManagedToolCommandGroups };

function validateManagedToolHealthProbes(healthProbes: readonly ManagedToolDescriptorHealthProbe[]): void {
  validateNonEmptyArray(healthProbes, "Managed tool descriptor health probes");
  for (const probe of healthProbes) validateManagedToolHealthProbe(probe);
  validateRequiredHealthProbe(healthProbes, ["opcore", "status", "--json"], "status");
  validateRequiredHealthProbe(healthProbes, ["opcore", "doctor", "--json"], "doctor");
}

export { validateManagedToolHealthProbes };

function validateManagedToolHealthProbe(probe: ManagedToolDescriptorHealthProbe): void {
  if (!probe || typeof probe !== "object") throw new Error("Managed tool descriptor health probe is required");
  validateNonEmptyString(probe.id, "Managed tool descriptor health probe id");
  validateStringArray(probe.command, "Managed tool descriptor health probe command", { allowEmpty: false });
  validateManagedToolCommandTokens(probe.command, "Managed tool descriptor health probe command");
  if (probe.command[0] !== "opcore") {
    throw new Error("Managed tool descriptor health probes must use opcore commands");
  }
  if (probe.expectedExitCode !== 0) {
    throw new Error("Managed tool descriptor health probe expectedExitCode must be 0");
  }
  if (probe.output !== "json") throw new Error("Managed tool descriptor health probe output must be json");
}

function validateRequiredHealthProbe(
  probes: readonly ManagedToolDescriptorHealthProbe[],
  command: readonly string[],
  name: string,
): void {
  if (!probes.some((probe) => sameStringArray(probe.command, command))) {
    throw new Error(`Managed tool descriptor health probes must include ${name}`);
  }
}

function validateManagedToolCapabilities(capabilities: ManagedToolDescriptorCapabilities): void {
  if (!capabilities || typeof capabilities !== "object")
    throw new Error("Managed tool descriptor capabilities are required");
  validateManagedToolGraphCapabilities(capabilities.graph);
  validateManagedToolEditCapabilities(capabilities.edit);
  validateManagedToolValidationCapabilities(capabilities.validation);
}

export { validateManagedToolCapabilities };
