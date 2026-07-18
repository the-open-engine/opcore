import type {
  PythonProjectContext,
  PythonProjectToolProvenance,
  PythonValidationAuthority,
  PythonValidationAuthoritySource
} from "@the-open-engine/opcore-contracts";

export interface PythonTypeAuthoritySelection {
  status: "selected" | "invalid_config" | "unsupported_target";
  authority?: PythonValidationAuthority;
  source?: PythonValidationAuthoritySource;
  tool?: PythonProjectToolProvenance;
  configPaths: readonly string[];
  message?: string;
}

interface AuthorityFacts {
  context: PythonProjectContext;
  explicit?: PythonValidationAuthority;
  mypy?: PythonProjectToolProvenance;
  pyright?: PythonProjectToolProvenance;
  configured: readonly PythonValidationAuthority[];
  configPaths: readonly string[];
}

export function selectPythonTypeAuthority(
  context: PythonProjectContext,
  explicit?: PythonValidationAuthority
): PythonTypeAuthoritySelection {
  const facts = authorityFacts(context, explicit);
  return invalidExplicit(facts) ?? invalidConfig(facts) ?? selectedAuthority(facts);
}

function authorityFacts(context: PythonProjectContext, explicit?: PythonValidationAuthority): AuthorityFacts {
  const mypy = context.tools.find((tool) => tool.tool === "mypy");
  const pyright = context.tools.find((tool) => tool.tool === "pyright");
  const configured = [
    ...(mypy?.configFile === undefined ? [] : ["mypy" as const]),
    ...(pyright?.configFile === undefined ? [] : ["pyright" as const])
  ];
  const reasonPaths = context.reasons
    .filter((reason) => reason.code === "invalid_config" && (reason.tool === "mypy" || reason.tool === "pyright"))
    .flatMap((reason) => reason.path === undefined ? [] : [reason.path]);
  const configPaths = [mypy?.configFile, pyright?.configFile, ...reasonPaths]
    .filter((path): path is string => path !== undefined);
  return { context, explicit, mypy, pyright, configured, configPaths: [...new Set(configPaths)].sort() };
}

function invalidExplicit(facts: AuthorityFacts): PythonTypeAuthoritySelection | undefined {
  if (facts.explicit === undefined || facts.explicit === "mypy" || facts.explicit === "pyright") return undefined;
  return {
    status: "invalid_config",
    configPaths: facts.configPaths,
    message: `Unknown explicit Python type authority: ${String(facts.explicit)}`
  };
}

function invalidConfig(facts: AuthorityFacts): PythonTypeAuthoritySelection | undefined {
  const malformed = facts.context.reasons.filter((reason) =>
    reason.code === "invalid_config" && (reason.tool === "mypy" || reason.tool === "pyright" || reason.tool === undefined)
  );
  if (malformed.length > 0) return invalidSelection(facts, malformed.map((reason) => reason.message).join("; "));
  if (facts.configured.length > 1) {
    return invalidSelection(facts, `Python project ${facts.context.projectRoot} configures both mypy and pyright`);
  }
  const configured = facts.configured[0];
  if (facts.explicit !== undefined && configured !== undefined && facts.explicit !== configured) {
    return invalidSelection(
      facts,
      `Explicit Python type authority ${facts.explicit} conflicts with configured ${configured} authority for ${facts.context.projectRoot}`
    );
  }
  return undefined;
}

function invalidSelection(facts: AuthorityFacts, message: string): PythonTypeAuthoritySelection {
  return {
    status: "invalid_config",
    configPaths: facts.configPaths,
    message
  };
}

function selectedAuthority(facts: AuthorityFacts): PythonTypeAuthoritySelection {
  const authority = facts.explicit ?? facts.configured[0];
  if (authority === undefined) {
    return {
      status: "unsupported_target",
      configPaths: facts.configPaths,
      message: `Python project ${facts.context.projectRoot} has no explicit or configured type-checker authority`
    };
  }
  return {
    status: "selected",
    ...authorityEvidence(facts, authority, facts.explicit === undefined ? "project_config" : "explicit"),
    configPaths: facts.configPaths
  };
}

function authorityEvidence(
  facts: AuthorityFacts,
  authority: PythonValidationAuthority,
  source: PythonValidationAuthoritySource
): Pick<PythonTypeAuthoritySelection, "authority" | "source" | "tool"> {
  const tool = authority === "mypy" ? facts.mypy : facts.pyright;
  return { authority, source, ...(tool === undefined ? {} : { tool }) };
}
