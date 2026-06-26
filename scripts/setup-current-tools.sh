#!/usr/bin/env bash
set -euo pipefail

# Current-tool invariant: wrappers execute external ACE-managed tools, never lattice packages under development.
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${repo_root}"
repo_root_physical="$(pwd -P)"
runtime_root="${repo_root}/.ace/runtime"
bin_dir="${runtime_root}/bin"
tooling_json="${runtime_root}/tooling.json"
run_dir="${repo_root}/.ace/run"
rox_runtime_dir="${repo_root}/.ace/rox"
idle_ms="${LATTICE_TOOL_DAEMON_IDLE_TIMEOUT_MS:-1800000}"

mkdir -p "${bin_dir}" "${run_dir}" "${rox_runtime_dir}"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

shell_quote() {
  printf '%q' "$1"
}

canonical_path() {
  local path="$1"
  node -e '
const fs = require("node:fs");

try {
  process.stdout.write(fs.realpathSync.native(process.argv[1]));
} catch {
  process.exit(1);
}
' "${path}"
}

canonical_dir() {
  local path="$1"
  (cd "${path}" 2>/dev/null && pwd -P)
}

is_inside_repo() {
  local path="$1"
  local real_path

  real_path="$(canonical_path "${path}" 2>/dev/null || true)"
  [[ -n "${real_path}" ]] || return 1
  case "${real_path}" in
    "${repo_root_physical}"|"${repo_root_physical}"/*) return 0 ;;
    *) return 1 ;;
  esac
}

implementation_package_dir() {
  local tool_name="$1"
  case "${tool_name}" in
    crg) printf 'packages/graph' ;;
    *) printf 'packages/%s' "${tool_name}" ;;
  esac
}

validate_source_path() {
  local tool_name="$1"
  local path="$2"
  local implementation_path

  [[ -n "${path}" ]] || return 1
  [[ -x "${path}" ]] || fail "${tool_name} source is not executable: ${path}"
  if is_inside_repo "${path}"; then
    implementation_path="$(implementation_package_dir "${tool_name}")"
    fail "${tool_name} source resolved inside lattice (${path}); use current external tools, not ${implementation_path}"
  fi
}

candidate_dirs=()
append_dir() {
  local dir="$1"
  [[ -n "${dir}" ]] || return 0
  candidate_dirs+=("${dir}")
}

append_dir "${LATTICE_CURRENT_TOOLS_DIR:-}"
append_dir "${ACE_CURRENT_TOOLS_DIR:-}"
append_dir "${repo_root}/../covibes/.ace/runtime/bin"
append_dir "${repo_root}/../cmdproof/.ace/runtime/bin"
append_dir "${repo_root}/../robustness-engine/.ace/runtime/bin"
append_dir "${repo_root}/../orchestra/.ace/runtime/bin"
append_dir "${HOME}/code/covibes/cmdproof/.ace/runtime/bin"
append_dir "${HOME}/code/covibes/robustness-engine/.ace/runtime/bin"
append_dir "${HOME}/code/covibes/orchestra/.ace/runtime/bin"

native_path_dirs=()
append_native_dir() {
  local dir="$1"
  [[ -n "${dir}" && -d "${dir}" ]] || return 0
  native_path_dirs+=("${dir}")
}

resolve_tool() {
  local tool_name="$1"
  local upper_name
  local env_var
  local env_value
  local dir
  local candidate
  local path_dir
  local path_entries

  upper_name="$(printf '%s' "${tool_name}" | tr '[:lower:]' '[:upper:]')"
  env_var="LATTICE_CURRENT_${upper_name}_PATH"
  env_value="${!env_var:-}"
  if [[ -n "${env_value}" ]]; then
    validate_source_path "${tool_name}" "${env_value}"
    canonical_path "${env_value}"
    return 0
  fi

  for dir in "${candidate_dirs[@]}"; do
    [[ -d "${dir}" ]] || continue
    candidate="${dir}/${tool_name}"
    if [[ -x "${candidate}" ]]; then
      validate_source_path "${tool_name}" "${candidate}"
      canonical_path "${candidate}"
      return 0
    fi
  done

  IFS=':' read -r -a path_entries <<< "${PATH:-}"
  for path_dir in "${path_entries[@]}"; do
    [[ -n "${path_dir}" ]] || path_dir="."
    dir="$(canonical_dir "${path_dir}" 2>/dev/null || true)"
    [[ -n "${dir}" ]] || continue
    candidate="${dir}/${tool_name}"
    if [[ -x "${candidate}" ]]; then
      if is_inside_repo "${candidate}"; then
        continue
      fi
      validate_source_path "${tool_name}" "${candidate}"
      canonical_path "${candidate}"
      return 0
    fi
  done

  fail "could not resolve current external ${tool_name}; set LATTICE_CURRENT_TOOLS_DIR or LATTICE_CURRENT_${upper_name}_PATH"
}

discover_native_tool_dir() {
  local tool_name="$1"
  local command_name="$2"
  local dir
  local candidate

  for dir in "${candidate_dirs[@]}"; do
    [[ -d "${dir}" ]] || continue
    candidate="${dir}/../native-tools/rox/${tool_name}/bin/${command_name}"
    if [[ -x "${candidate}" ]] && "${candidate}" --help 2>/dev/null | grep -q 'Analyze source code'; then
      canonical_dir "${candidate%/*}"
      return 0
    fi
  done

  while IFS= read -r candidate; do
    if [[ -x "${candidate}" ]] && "${candidate}" --help 2>/dev/null | grep -q 'Analyze source code'; then
      canonical_dir "${candidate%/*}"
      return 0
    fi
  done < <(find "${HOME}/.cache/ace/native-tools/rox/${tool_name}" -path "*/install/bin/${command_name}" -type f -perm -111 -print 2>/dev/null || true)
}

write_wrapper() {
  local tool_name="$1"
  local source_path="$2"
  local wrapper_path="${bin_dir}/${tool_name}"
  local maybe_cix_root=""
  local native_path=""

  if [[ "${tool_name}" == "cix" ]]; then
    maybe_cix_root='export CIX_DAEMON_ROOT_DIR="${CIX_DAEMON_ROOT_DIR:-$repo_root_physical}"'
  fi
  if [[ "${tool_name}" == "rox" && "${#native_path_dirs[@]}" -gt 0 ]]; then
    native_path="$(IFS=:; printf '%s' "${native_path_dirs[*]}")"
  fi

  cat > "${wrapper_path}" <<EOF_WRAPPER
#!/usr/bin/env bash
set -euo pipefail
repo_root=$(shell_quote "${repo_root}")
repo_root_physical=$(shell_quote "${repo_root_physical}")
source_path=$(shell_quote "${source_path}")
runtime_dir="\${LATTICE_CURRENT_TOOL_RUNTIME_DIR:-$(shell_quote "${rox_runtime_dir}")}"
idle_ms="\${LATTICE_TOOL_DAEMON_IDLE_TIMEOUT_MS:-$(shell_quote "${idle_ms}")}"
cd "\$repo_root"
mkdir -p "\$runtime_dir"
export XDG_RUNTIME_DIR="\$runtime_dir"
export ACE_MANAGED_TOOL_XDG_RUNTIME_DIR="\$runtime_dir"
export ROBUSTNESS_ENGINE_DAEMON_IDLE_TIMEOUT_MS="\$idle_ms"
if [[ -n $(shell_quote "${native_path}") ]]; then
  export PATH=$(shell_quote "${native_path}"):"\$PATH"
fi
${maybe_cix_root}
exec "\$source_path" "\$@"
EOF_WRAPPER
  chmod 755 "${wrapper_path}"
}

rox_source="$(resolve_tool rox)"
crg_source="$(resolve_tool crg)"
cix_source="$(resolve_tool cix)"
append_native_dir "$(discover_native_tool_dir rust-code-analysis-cli rust-code-analysis-cli)"

write_wrapper rox "${rox_source}"
write_wrapper crg "${crg_source}"
write_wrapper cix "${cix_source}"

LATTICE_TOOLING_JSON="${tooling_json}" \
LATTICE_REPO_ROOT="${repo_root}" \
LATTICE_RUNTIME_ROOT="${runtime_root}" \
LATTICE_BIN_DIR="${bin_dir}" \
LATTICE_RUN_DIR="${run_dir}" \
LATTICE_ROX_RUNTIME_DIR="${rox_runtime_dir}" \
LATTICE_IDLE_MS="${idle_ms}" \
LATTICE_ROX_SOURCE="${rox_source}" \
LATTICE_ROX_NATIVE_PATH="${native_path_dirs[*]:-}" \
LATTICE_CRG_SOURCE="${crg_source}" \
LATTICE_CIX_SOURCE="${cix_source}" \
node <<'NODE'
const fs = require("node:fs");

const relativeToolPath = (name) => `.ace/runtime/bin/${name}`;

const currentTool = (name, sourcePath) => ({
  available: true,
  mode: "external-current-tool",
  sourcePath,
  wrapperPath: `${process.env.LATTICE_BIN_DIR}/${name}`
});

const aceTool = (name, sourcePath, options) => ({
  executablePath: relativeToolPath(name),
  sourcePath,
  version: null,
  ready: true,
  reason: null,
  launcher: {
    sourceStrategy: {
      kind: "direct-path",
      path: relativeToolPath(name)
    },
    environment: {
      prependPath: [".ace/runtime/bin", ...options.prependPath],
      unset: [],
      xdgRuntimeDir: options.xdgRuntimeDir
    },
    healthProbe: {
      args: ["--version"],
      parser: "first-non-empty-output-line"
    },
    daemonPolicy: {
      retryWithoutDaemonOnVersionSkew: options.retryWithoutDaemonOnVersionSkew
    }
  },
  nativeDependencies: {}
});

const metadata = {
  schemaVersion: 1,
  packagingMode: "current_external_tools",
  runtimeRoot: ".ace/runtime",
  generatedAt: new Date().toISOString(),
  generatedBy: {
    name: "lattice-current-tool-setup",
    version: "0.1.0-alpha.0"
  },
  tooling: {
    aceTools: {
      binRoot: ".ace/runtime/bin",
      tools: {
        rox: aceTool("rox", process.env.LATTICE_ROX_SOURCE, {
          xdgRuntimeDir: ".ace/rox",
          retryWithoutDaemonOnVersionSkew: true,
          prependPath: (process.env.LATTICE_ROX_NATIVE_PATH || "").split(/\s+/).filter(Boolean)
        }),
        crg: aceTool("crg", process.env.LATTICE_CRG_SOURCE, {
          xdgRuntimeDir: null,
          retryWithoutDaemonOnVersionSkew: false,
          prependPath: []
        }),
        cix: aceTool("cix", process.env.LATTICE_CIX_SOURCE, {
          xdgRuntimeDir: ".ace/rox",
          retryWithoutDaemonOnVersionSkew: false,
          prependPath: []
        })
      }
    }
  },
  latticeCurrentTools: {
    version: 1,
    owner: "lattice-current-tool-setup",
    root: process.env.LATTICE_REPO_ROOT,
    runtimeRoot: process.env.LATTICE_RUNTIME_ROOT,
    bin: process.env.LATTICE_BIN_DIR,
    run: process.env.LATTICE_RUN_DIR,
    roxRuntime: process.env.LATTICE_ROX_RUNTIME_DIR,
    idleTimeoutMs: Number(process.env.LATTICE_IDLE_MS),
    invariant: "wrappers execute current external ACE-managed tools, never lattice packages under development",
    tools: {
      rox: currentTool("rox", process.env.LATTICE_ROX_SOURCE),
      crg: currentTool("crg", process.env.LATTICE_CRG_SOURCE),
      cix: currentTool("cix", process.env.LATTICE_CIX_SOURCE)
    }
  }
};

fs.writeFileSync(process.env.LATTICE_TOOLING_JSON, `${JSON.stringify(metadata, null, 2)}\n`);
NODE

printf 'current tool wrappers ready at %s\n' "${bin_dir}"
