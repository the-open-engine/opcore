#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

run_step() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run_step npm run setup:tools
run_step npm run ci
run_step npm run current-tools:validate-all
run_step npm run current-tools:validate-rust-graph
