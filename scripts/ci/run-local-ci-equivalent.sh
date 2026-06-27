#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

generated_artifact_backup=""

run_step() {
  printf '\n==> %s\n' "$*"
  "$@"
}

snapshot_generated_artifacts() {
  generated_artifact_backup="$(mktemp -d "${TMPDIR:-/tmp}/opcore-generated-artifacts.XXXXXX")"
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    mkdir -p "${generated_artifact_backup}/$(dirname "${path}")"
    cp -p "${path}" "${generated_artifact_backup}/${path}"
  done < <(
    git ls-files \
      'packages/opcore-graph-core-*/lattice-graph-core' \
      'packages/opcore-graph-core-*/lattice-graph-core.sha256' \
      'packages/opcore-graph-core-*/metadata.json'
  )
}

restore_generated_artifacts() {
  [ -n "${generated_artifact_backup}" ] || return 0
  [ -d "${generated_artifact_backup}" ] || return 0
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    cp -p "${generated_artifact_backup}/${path}" "${path}"
  done < <(
    git ls-files \
      'packages/opcore-graph-core-*/lattice-graph-core' \
      'packages/opcore-graph-core-*/lattice-graph-core.sha256' \
      'packages/opcore-graph-core-*/metadata.json'
  )
  rm -rf "${generated_artifact_backup}"
  generated_artifact_backup=""
}

collect_changed_files() {
  local base_ref="${OPCORE_LOCAL_CI_BASE_REF:-origin/main}"
  {
    if git rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1; then
      git diff --name-only --diff-filter=ACMRTUXB "${base_ref}...HEAD" --
    fi
    git diff --name-only --diff-filter=ACMRTUXB --
    git diff --cached --name-only --diff-filter=ACMRTUXB --
    git ls-files --others --exclude-standard
  } | sed '/^$/d' | sort -u
}

docs_or_agent_only_changes() {
  local changed_file_list="$1"
  local path
  local saw_change=0

  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    saw_change=1
    case "${path}" in
      README.md|AGENTS.md|CLAUDE.md|CONTRIBUTING.md|SECURITY.md|CHANGELOG.md|CODE_OF_CONDUCT.md|.changeset/README.md)
        ;;
      .github/ISSUE_TEMPLATE/*.md|.github/pull_request_template.md)
        ;;
      docs/release/*)
        return 1
        ;;
      docs/*.md)
        ;;
      *)
        return 1
        ;;
    esac
  done < "${changed_file_list}"

  [ "${saw_change}" -eq 1 ]
}

run_docs_or_agent_gate() {
  run_step npm run setup:tools
  run_step bash -n scripts/ci/run-local-ci-equivalent.sh
  run_step node scripts/check-release-hygiene.mjs
  run_step node scripts/check-workspace.mjs
  run_step node scripts/check-provenance.mjs
  run_step npm run current-tools:validate-changed
}

changed_file_list="$(mktemp "${TMPDIR:-/tmp}/opcore-local-ci-changed.XXXXXX")"
trap 'restore_generated_artifacts; rm -f "${changed_file_list}"' EXIT
collect_changed_files > "${changed_file_list}"

if docs_or_agent_only_changes "${changed_file_list}"; then
  run_docs_or_agent_gate
  exit 0
fi

run_step npm run setup:tools
snapshot_generated_artifacts
run_step npm run ci
restore_generated_artifacts
run_step npm run current-tools:validate-all
run_step npm run current-tools:validate-rust-graph
