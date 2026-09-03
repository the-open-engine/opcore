import { validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateStringArray,
  validateValidationChecks,
} from "../shared/validators-01.js";
import { validatePythonProjectContexts } from "../validation/python-project-validators-01.js";
import type {
  OpcoreInitInteraction,
  OpcoreInitLanguageSetting,
  OpcoreInitPythonEnvironment,
  OpcoreInitSettings,
  OpcoreInitTiming,
} from "./init-contracts.js";

function validateOpcoreInitSettings(settings: OpcoreInitSettings): OpcoreInitSettings {
  validateRequiredObject(settings, "Opcore init settings are required");
  if (!Array.isArray(settings.languages)) {
    throw new Error("Opcore init settings languages must be an array");
  }
  for (const language of settings.languages) {
    validateOpcoreInitLanguageSetting(language);
  }
  if (settings.python !== undefined) validateOpcoreInitPythonEnvironment(settings.python);
  return settings;
}

export { validateOpcoreInitSettings };

function validateOpcoreInitLanguageSetting(setting: OpcoreInitLanguageSetting): OpcoreInitLanguageSetting {
  validateRequiredObject(setting, "Opcore init language setting is required");
  validateNonEmptyString(setting.language, "Opcore init language setting language");
  validateNonNegativeInteger(setting.files, "Opcore init language setting files");
  if (!includesString(["supported", "retained", "unsupported", "degraded"] as const, setting.state)) {
    throw new Error(`Unknown Opcore init language setting state: ${String(setting.state)}`);
  }
  if (!includesString(["supported", "unsupported"] as const, setting.graph)) {
    throw new Error(`Unknown Opcore init language setting graph: ${String(setting.graph)}`);
  }
  if (!includesString(["supported", "retained", "unsupported", "degraded"] as const, setting.validation)) {
    throw new Error(`Unknown Opcore init language setting validation: ${String(setting.validation)}`);
  }
  validateValidationChecks(setting.checks, "Opcore init language setting checks");
  validateStringArray(setting.notes, "Opcore init language setting notes", {
    allowEmpty: true,
  });
  return setting;
}

export { validateOpcoreInitLanguageSetting };

function validateOpcoreInitPythonEnvironment(environment: OpcoreInitPythonEnvironment): OpcoreInitPythonEnvironment {
  validateRequiredObject(environment, "Opcore init Python environment is required");
  if (!Array.isArray(environment.dependencyManagers)) {
    throw new Error("Opcore init Python dependencyManagers must be an array");
  }
  for (const manager of environment.dependencyManagers) {
    validateRequiredObject(manager, "Opcore init Python dependency manager is required");
    if (!includesString(["pyproject", "requirements", "pipfile", "poetry", "uv"] as const, manager.kind)) {
      throw new Error(`Unknown Opcore init Python dependency manager kind: ${String(manager.kind)}`);
    }
    validateRepoRelativePath(manager.path);
  }
  if (!Array.isArray(environment.virtualEnvironments)) {
    throw new Error("Opcore init Python virtualEnvironments must be an array");
  }
  for (const virtualEnvironment of environment.virtualEnvironments) {
    validateRequiredObject(virtualEnvironment, "Opcore init Python virtual environment is required");
    if (virtualEnvironment.kind !== "venv") {
      throw new Error(`Unknown Opcore init Python virtual environment kind: ${String(virtualEnvironment.kind)}`);
    }
    validateRepoRelativePath(virtualEnvironment.path);
  }
  validateStringArray(environment.notes, "Opcore init Python environment notes", { allowEmpty: true });
  if (environment.contexts !== undefined) validatePythonProjectContexts(environment.contexts);
  return environment;
}

export { validateOpcoreInitPythonEnvironment };

function validateOpcoreInitInteraction(interaction: OpcoreInitInteraction): OpcoreInitInteraction {
  validateRequiredObject(interaction, "Opcore init interaction is required");
  if (typeof interaction.tty !== "boolean") {
    throw new Error("Opcore init interaction tty must be boolean");
  }
  if (!includesString(["not_requested", "requested", "approved", "declined"] as const, interaction.promptState)) {
    throw new Error(`Unknown Opcore init interaction promptState: ${String(interaction.promptState)}`);
  }
  return interaction;
}

export { validateOpcoreInitInteraction };

function validateOpcoreInitTiming(timing: OpcoreInitTiming): OpcoreInitTiming {
  validateRequiredObject(timing, "Opcore init timings are required");
  validateNonNegativeNumber(timing.scanMs, "Opcore init timing scanMs");
  validateNonNegativeNumber(timing.planMs, "Opcore init timing planMs");
  validateNonNegativeNumber(timing.promptMs, "Opcore init timing promptMs");
  validateNonNegativeNumber(timing.applyMs, "Opcore init timing applyMs");
  validateNonNegativeNumber(timing.totalMs, "Opcore init timing totalMs");
  validateNonNegativeNumber(timing.firstOutputMs, "Opcore init timing firstOutputMs");
  return timing;
}

export { validateOpcoreInitTiming };
