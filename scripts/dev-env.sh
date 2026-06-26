#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  printf 'source this file instead: source scripts/dev-env.sh\n' >&2
  exit 1
fi

lattice_repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
lattice_bin_dir="${lattice_repo_root}/.ace/runtime/bin"
lattice_runtime_dir="${lattice_repo_root}/.ace/rox"

if [[ ! -x "${lattice_bin_dir}/rox" || ! -x "${lattice_bin_dir}/crg" || ! -x "${lattice_bin_dir}/cix" ]]; then
  printf 'lattice current-tool wrappers are missing; run npm run setup:tools\n' >&2
  return 1
fi

case ":${PATH:-}:" in
  *:"${lattice_bin_dir}":*) ;;
  *) export PATH="${lattice_bin_dir}${PATH:+:${PATH}}" ;;
esac

export LATTICE_CURRENT_TOOL_RUNTIME_DIR="${LATTICE_CURRENT_TOOL_RUNTIME_DIR:-${lattice_runtime_dir}}"
export CIX_DAEMON_ROOT_DIR="${CIX_DAEMON_ROOT_DIR:-$(cd "${lattice_repo_root}" && pwd -P)}"
