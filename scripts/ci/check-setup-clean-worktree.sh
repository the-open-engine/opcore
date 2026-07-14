#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/opcore-setup-clean.XXXXXX")"
worktree_path="${temp_root}/repo"

cleanup() {
  git -C "${repo_root}" worktree remove --force "${worktree_path}" >/dev/null 2>&1 || true
  rm -rf "${temp_root}"
}
trap cleanup EXIT

git -C "${repo_root}" worktree add --detach "${worktree_path}" HEAD

(
  cd "${worktree_path}"
  npm run setup
)

status="$(git -C "${worktree_path}" status --short --untracked-files=normal)"
if [ -n "${status}" ]; then
  printf 'error: npm run setup must leave a fresh worktree clean.\n' >&2
  printf 'Dirty paths after setup:\n%s\n' "${status}" >&2
  exit 1
fi

printf 'setup clean-worktree check passed\n'
