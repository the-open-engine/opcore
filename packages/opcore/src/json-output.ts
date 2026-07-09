import type {
  CommandRouterResult,
  ValidationResult,
  ValidationResultManifest
} from "@the-open-engine/opcore-contracts";

export function commandRouterResultForJsonOutput(result: CommandRouterResult): CommandRouterResult {
  if (!result.json || result.validationResult?.manifest === undefined) return result;
  if (isProductScanCommand(result.canonicalCommand)) return result;
  if (isValidationManifestCommand(result.canonicalCommand)) return result;
  return {
    ...result,
    validationResult: compactValidationResult(result.validationResult)
  };
}

function compactValidationResult(result: ValidationResult): ValidationResult {
  if (result.manifest === undefined) return result;
  return {
    ...result,
    manifest: compactValidationManifest(result.manifest)
  };
}

function compactValidationManifest(manifest: ValidationResultManifest): ValidationResultManifest {
  const compact: ValidationResultManifest = {
    schemaVersion: manifest.schemaVersion,
    checks: [...manifest.checks],
    generatedAt: manifest.generatedAt
  };
  if (manifest.durationMs !== undefined) compact.durationMs = manifest.durationMs;
  return compact;
}

function isValidationManifestCommand(canonicalCommand: readonly string[]): boolean {
  return canonicalCommand[0] === "opcore" && (canonicalCommand[1] === "check" || canonicalCommand[1] === "validate") && canonicalCommand[2] === "manifest";
}

function isProductScanCommand(canonicalCommand: readonly string[]): boolean {
  return canonicalCommand[0] === "opcore" && canonicalCommand[1] === "scan";
}
