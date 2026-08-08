import { validateRepoRelativePath } from "../shared/path-validators.js";
import { PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID } from "./python-project-contracts-01.js";

function validatePythonCapabilityRunSchema(run: { schemaId: string; schemaVersion: number }): void {
  if (run.schemaId !== PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID) {
    throw new Error(`Python validation capability run schemaId must be ${PYTHON_VALIDATION_CAPABILITY_RUN_SCHEMA_ID}`);
  }
  if (run.schemaVersion !== 1) throw new Error("Python validation capability run schemaVersion must be 1");
}

export { validatePythonCapabilityRunSchema };

function validateExactObjectKeys(value: object, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} has unexpected properties: ${unexpected.sort().join(", ")}`);
  }
}

export { validateExactObjectKeys };

function containsHostAbsolutePath(value: string): boolean {
  return (
    /^(?:\/|\\\\|[A-Za-z]:[\\/])/u.test(value) ||
    /[\s("'=](?:\/|\\\\|[A-Za-z]:[\\/])/u.test(value) ||
    /file:\/\//iu.test(value)
  );
}

export { containsHostAbsolutePath };

function validateContextDocFilename(filename: string): string {
  validateRepoRelativePath(filename);
  if (filename.includes("/")) {
    throw new Error(`Required context doc policy filename must be a basename: ${filename}`);
  }
  return filename;
}

export { validateContextDocFilename };

function validateContextDocRequiredPath(path: string): string {
  if (path === ".") return path;
  return validateRepoRelativePath(path);
}

export { validateContextDocRequiredPath };
