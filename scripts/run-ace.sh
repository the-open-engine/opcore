#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

candidate_bins=()

if [[ -n "${ACE_BIN:-}" ]]; then
  candidate_bins+=("${ACE_BIN}")
fi

candidate_bins+=(
  "${repo_root}/external/ace/bin/ace"
)

if command -v ace >/dev/null 2>&1; then
  candidate_bins+=("$(command -v ace)")
fi

candidate_bins+=(
  "${HOME}/code/covibes/ace/bin/ace"
  "${HOME}/code/covibes/agents/external/ace/bin/ace"
  "${HOME}/code/covibes/orchestra/external/ace/bin/ace"
)

if [[ -z "${ROBUSTNESS_ENGINE_DIR:-}" ]]; then
  for robustness_engine_dir in \
    "${repo_root}/external/robustness-engine" \
    "${HOME}/code/covibes/robustness-engine" \
    "${HOME}/code/covibes/agents/external/robustness-engine" \
    "${HOME}/code/covibes/orchestra/vendor/robustness-engine"; do
    if [[ -f "${robustness_engine_dir}/crates/clone-indexer/Cargo.toml" ]]; then
      export ROBUSTNESS_ENGINE_DIR="${robustness_engine_dir}"
      break
    fi
  done
fi

for ace_bin in "${candidate_bins[@]}"; do
  if [[ -x "${ace_bin}" ]]; then
    exec "${ace_bin}" "$@"
  fi
  if [[ -f "${ace_bin}" ]]; then
    exec node "${ace_bin}" "$@"
  fi
done

cat >&2 <<'EOF'
ACE CLI not found.

Set ACE_BIN=/path/to/ace, install ace on PATH, vendor it at external/ace,
or keep the Covibes ACE checkout at ~/code/covibes/ace.
EOF
exit 127
