#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
binary=${1:?usage: scripts/test-install-multi.sh BINARY}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/opcore multi install.XXXXXX")
fixture=$(cd -- "$fixture" && pwd -P)
cleanup_fixture() {
  local result=$?
  if ((result != 0)) && [[ -f "$fixture/output" ]]; then cat "$fixture/output" >&2; fi
  rm -rf -- "$fixture"
}
trap cleanup_fixture EXIT
report_failure() {
  local status=$? line=$1 command=$2
  printf 'multi-agent installer test failed at line %s: %s\n' "$line" "$command" >&2
  exit "$status"
}
trap 'report_failure "$LINENO" "$BASH_COMMAND"' ERR

run_install() {
  env -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u OPCORE_SKILL_DIR \
    HOME="$test_home" OPCORE_BIN_DIR="$test_home/shared bin" \
    "$repo_root/scripts/install.sh" --binary "$binary" "$@" >"$fixture/output" 2>&1
}

assert_integrations() {
  local name root
  for name in codex claude; do
    root="$test_home/.$name"
    test -f "$root/opcore/install.receipt"
    test -f "$root/opcore/asp-server-python-native.json"
    test -x "$root/opcore/uninstall.sh"
  done
  test -f "$test_home/.agents/skills/opcore/SKILL.md"
  test -f "$test_home/.agents/skills/opcore/agents/openai.yaml"
  test -f "$test_home/.claude/skills/opcore/SKILL.md"
  test -x "$test_home/shared bin/opcore"
}

assert_inactive_registry() {
  local registry slot
  registry=$(find "$test_home/.local/share/opcore/owners" -mindepth 1 -maxdepth 1 -type d)
  for slot in codex claude; do
    test "$(cat "$registry/$slot")" = 'opcore.owner.absent.v1'
  done
  test "$(find "$registry" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 2
}

for first in codex claude; do
  test_home="$fixture/remove $first first"
  mkdir -p "$test_home/.codex" "$test_home/.claude"
  run_install
  assert_integrations
  test -f "$test_home/.codex/hooks.json"
  test -f "$test_home/.claude/settings.json"
  run_install
  run_install --uninstall --agent "$first"
  test ! -e "$test_home/.$first/opcore/install.receipt"
  test -x "$test_home/shared bin/opcore"
  second=codex
  if [[ "$first" == codex ]]; then second=claude; fi
  test -f "$test_home/.$second/opcore/hook-install.json"
  run_install --uninstall --agent "$second"
  test ! -e "$test_home/shared bin/opcore"
  assert_inactive_registry
done

test_home="$fixture/explicit restriction"
mkdir -p "$test_home/.codex" "$test_home/.claude"
for selected in codex claude; do
  run_install --agent "$selected" --no-hooks
  test ! -e "$test_home/.codex/hooks.json"
  test ! -e "$test_home/.claude/settings.json"
  other=codex
  if [[ "$selected" == codex ]]; then other=claude; fi
  test ! -e "$test_home/.$other/opcore/install.receipt"
  registry=$(find "$test_home/.local/share/opcore/owners" -mindepth 1 -maxdepth 1 -type d)
  grep -Fx 'opcore.owner.absent.v1' "$registry/$other" >/dev/null
  grep -Fx "$test_home/.$selected" "$registry/$selected" >/dev/null
  run_install --uninstall --agent "$selected"
done

# Default cleanup reads recorded custom roots even without detection variables.
test_home="$fixture/custom roots"
mkdir -p "$test_home"
env HOME="$test_home" CODEX_HOME="$test_home/custom codex" \
  CLAUDE_CONFIG_DIR="$test_home/custom claude" OPCORE_BIN_DIR="$test_home/shared bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --no-hooks >"$fixture/output" 2>&1
run_install --uninstall
test ! -e "$test_home/shared bin/opcore"
test ! -e "$test_home/custom codex/opcore/install.receipt"
test ! -e "$test_home/custom claude/opcore/install.receipt"

test_home="$fixture/update both"
mkdir -p "$test_home/.codex" "$test_home/.claude"
run_install --no-hooks
updated_binary="$fixture/updated binary"
cp "$binary" "$updated_binary"
printf '\n' >> "$updated_binary"
original_binary=$binary
binary=$updated_binary
if run_install --agent codex; then
  printf 'restricted update replaced a shared binary\n' >&2; exit 1
fi
cmp "$original_binary" "$test_home/shared bin/opcore"
run_install --no-hooks
cmp "$binary" "$test_home/shared bin/opcore"
assert_integrations
# Check every owned artifact before removing any integration.
printf 'modified\n' >> "$test_home/.claude/opcore/asp-server.json"
if run_install --uninstall; then exit 1; fi
test -f "$test_home/.codex/opcore/install.receipt"
test -f "$test_home/.codex/opcore/asp-server.json"
run_install --no-hooks --force
run_install --uninstall
binary=$original_binary
test ! -e "$test_home/shared bin/opcore"

test_home="$fixture/partial hook failure"
mkdir -p "$test_home/.codex" "$test_home/.claude"
printf 'invalid json\n' > "$test_home/.claude/settings.json"
if run_install; then exit 1; fi
test ! -e "$test_home/.codex/opcore/install.receipt"
test ! -e "$test_home/.claude/opcore/install.receipt"
test ! -e "$test_home/.codex/hooks.json"
test ! -e "$test_home/shared bin/opcore"
# The invalid preexisting settings are not owned by this installer.
grep -Fx 'invalid json' "$test_home/.claude/settings.json" >/dev/null

test_home="$fixture/ambiguous receipt"
mkdir -p "$test_home/.codex" "$test_home/.claude"
run_install --no-hooks
cp "$test_home/.claude/opcore/install.receipt" "$fixture/receipt backup"
printf 'hooks no\n' >> "$test_home/.claude/opcore/install.receipt"
if run_install --uninstall --agent codex; then exit 1; fi
test -f "$test_home/.codex/opcore/install.receipt"
cp "$fixture/receipt backup" "$test_home/.claude/opcore/install.receipt"
run_install --uninstall

test_home="$fixture/no agent"
mkdir -p "$test_home"
if run_install; then exit 1; fi
grep -F 'no supported agent detected; pass --agent codex or --agent claude' "$fixture/output" >/dev/null
for only in codex claude; do
  mkdir -p "$test_home/.$only"
  run_install --no-hooks
  test -f "$test_home/.$only/opcore/install.receipt"
  run_install --uninstall
  rmdir "$test_home/.$only/skills" 2>/dev/null || true
  rmdir "$test_home/.$only"
done
# Historical v5 cleanup does not require a registry that did not yet exist.
test_home="$fixture/direct legacy v5 removal"
mkdir -p "$test_home/.codex"
run_install --agent codex --no-hooks
receipt="$test_home/.codex/opcore/install.receipt"
awk '
  NR == 1 { print "opcore.install.v5"; next }
  $1 != "agent" && $1 != "owners_path" { print }
' "$receipt" > "$fixture/direct legacy receipt"
cp "$fixture/direct legacy receipt" "$receipt"
rm -rf -- "$test_home/.local/share/opcore/owners"
run_install --uninstall --agent codex
test ! -e "$test_home/shared bin/opcore"
test ! -e "$receipt"

# A v5 single-agent receipt can establish ownership before a registry exists.
for legacy in codex claude; do
  test_home="$fixture/legacy $legacy"
  mkdir -p "$test_home/.codex" "$test_home/.claude"
  run_install --agent "$legacy" --no-hooks
  receipt="$test_home/.$legacy/opcore/install.receipt"
  awk '
    NR == 1 { print "opcore.install.v5"; next }
    $1 != "agent" && $1 != "owners_path" { print }
  ' "$receipt" > "$fixture/legacy receipt"
  cp "$fixture/legacy receipt" "$receipt"
  rm -rf -- "$test_home/.local/share/opcore/owners"
  run_install --no-hooks
  assert_integrations
  run_install --uninstall --agent "$legacy"
  test -x "$test_home/shared bin/opcore"
  run_install --uninstall
  test ! -e "$test_home/shared bin/opcore"
done

# A prior v5 uninstaller must reject v6 instead of deleting a shared binary.
test_home="$fixture/v5 uninstaller boundary"
mkdir -p "$test_home/.codex" "$test_home/.claude"
run_install --no-hooks
legacy_v5_remove_probe() {
  local schema
  read -r schema < "$1"
  [[ "$schema" == opcore.install.v5 ]] || return 1
  rm -f -- "$2"
}
if legacy_v5_remove_probe \
  "$test_home/.codex/opcore/install.receipt" \
  "$test_home/shared bin/opcore"; then
  printf 'a v5 cleanup path accepted a shared v6 receipt\n' >&2
  exit 1
fi
test -x "$test_home/shared bin/opcore"
run_install --uninstall

# Invalid hook configuration must preserve every earlier integration and binary.
for first in codex claude; do
  test_home="$fixture/failed update remove $first"
  mkdir -p "$test_home/.codex" "$test_home/.claude"
  run_install --no-hooks
  printf 'invalid json\n' > "$test_home/.codex/hooks.json"
  binary=$updated_binary
  if run_install; then exit 1; fi
  for selected in codex claude; do
    grep -Fx 'hooks no' "$test_home/.$selected/opcore/install.receipt" >/dev/null
  done
  cmp "$original_binary" "$test_home/shared bin/opcore"
  run_install --uninstall --agent "$first"
  test -x "$test_home/shared bin/opcore"
  run_install --uninstall
  test ! -e "$test_home/shared bin/opcore"
  binary=$original_binary
done

# A stale peer must stop removal before the selected agent changes anything.
test_home="$fixture/stale ownership"
mkdir -p "$test_home/.codex" "$test_home/.claude"
run_install --no-hooks
owners=$(find "$test_home/.local/share/opcore/owners" -mindepth 1 -maxdepth 1 -type d)
cp "$test_home/.claude/opcore/install.receipt" "$fixture/peer receipt"
cp "$owners/claude" "$fixture/peer owner"
for corruption in missing-receipt hidden-record trailing-bytes missing-owner; do
  case "$corruption" in
    missing-receipt) rm "$test_home/.claude/opcore/install.receipt" ;;
    hidden-record) cp "$owners/claude" "$owners/.unknown" ;;
    trailing-bytes) printf 'trailing' >> "$owners/claude" ;;
    missing-owner) rm "$owners/claude" ;;
  esac
  if run_install --uninstall; then exit 1; fi
  if run_install --uninstall --agent codex; then exit 1; fi
  test -f "$test_home/.codex/opcore/install.receipt"
  test -x "$test_home/shared bin/opcore"
  cp "$fixture/peer receipt" "$test_home/.claude/opcore/install.receipt"
  cp "$fixture/peer owner" "$owners/claude"
  rm -f "$owners/.unknown"
done
run_install --uninstall

# A custom owner remains discoverable through its required fixed slot even
# when its environment variable is absent.
test_home="$fixture/missing custom owner"
mkdir -p "$test_home/.claude"
custom_codex="$test_home/custom codex"
env HOME="$test_home" CODEX_HOME="$custom_codex" \
  OPCORE_BIN_DIR="$test_home/shared bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --no-hooks >"$fixture/output" 2>&1
owners=$(find "$test_home/.local/share/opcore/owners" -mindepth 1 -maxdepth 1 -type d)
cp "$owners/codex" "$fixture/custom owner"
rm "$owners/codex"
if run_install --uninstall; then exit 1; fi
if run_install --uninstall --agent claude; then exit 1; fi
test -f "$custom_codex/opcore/install.receipt"
test -x "$test_home/shared bin/opcore"
cp "$fixture/custom owner" "$owners/codex"
env HOME="$test_home" CODEX_HOME="$custom_codex" \
  OPCORE_BIN_DIR="$test_home/shared bin" \
  "$repo_root/scripts/install.sh" --uninstall >/dev/null

# Reject a blocked second destination before creating the first integration.
test_home="$fixture/blocked destination"
mkdir -p "$test_home/.codex" "$test_home/.claude"
printf 'file\n' > "$test_home/.claude/skills"
if run_install --no-hooks; then exit 1; fi
test ! -e "$test_home/.codex/opcore"
test ! -e "$test_home/shared bin/opcore"

printf 'multi-agent installer tests passed\n'
