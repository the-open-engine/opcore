#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
binary=${1:?usage: scripts/test-install.sh /path/to/opcore}
temp_root=${TMPDIR:-/tmp}
fixture=$(mktemp -d "$temp_root/opcore install.XXXXXX")
fixture=$(cd -- "$fixture" && pwd -P)
trap 'rm -rf -- "$fixture"' EXIT
report_failure() {
  local status=$? line=$1 command=$2
  printf 'installer test failed at line %s: %s\n' "$line" "$command" >&2
  exit "$status"
}
trap 'report_failure "$LINENO" "$BASH_COMMAND"' ERR

file_digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
  else
    shasum -a 256 < "$1" | awk '{print $1}'
  fi
}

codex_home="$fixture/codex user"
codex_root="$codex_home/.codex"
codex_bin="$codex_home/bin"
install_output="$fixture/install-output"

if HOME="$codex_home" CODEX_HOME="$codex_root" \
  "$repo_root/scripts/install.sh" --agent >"$fixture/missing-value" 2>&1; then
  printf 'missing --agent value unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F -- '--agent requires a value' "$fixture/missing-value" >/dev/null
if (
  cd "$fixture"
  HOME="$fixture/option value home" CODEX_HOME="$fixture/option value codex" \
    "$repo_root/scripts/install.sh" --bin-dir --hooks --binary "$binary"
) >"$fixture/option-value-output" 2>&1; then
  printf 'option-looking --bin-dir value unexpectedly accepted\n' >&2
  exit 1
fi
grep -F -- '--bin-dir requires a value' "$fixture/option-value-output" >/dev/null
test ! -e "$fixture/--hooks"
for empty_option in agent bin-dir binary; do
  empty_home="$fixture/empty $empty_option home"
  if (
    cd "$fixture"
    HOME="$empty_home" CODEX_HOME="$empty_home/.codex" \
      "$repo_root/scripts/install.sh" \
        "--$empty_option" '' --agent codex --binary "$binary"
  ) >"$fixture/empty-$empty_option-output" 2>&1; then
    printf 'empty --%s value unexpectedly accepted\n' "$empty_option" >&2
    exit 1
  fi
  grep -F -- "--$empty_option requires a value" \
    "$fixture/empty-$empty_option-output" >/dev/null
  test ! -e "$empty_home/.local/bin/opcore"
done
test ! -e "$fixture/opcore"

receipt_home="$fixture/receipt collision user"
receipt_root="$receipt_home/.codex"
mkdir -p "$receipt_root/opcore/install.receipt"
if HOME="$receipt_home" CODEX_HOME="$receipt_root" \
  OPCORE_BIN_DIR="$receipt_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" \
    >"$fixture/receipt-directory-output" 2>&1; then
  printf 'install receipt directory unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'install receipt path is not a regular file' \
  "$fixture/receipt-directory-output" >/dev/null
test ! -e "$receipt_home/bin/opcore"

hook_receipt_home="$fixture/hook receipt collision user"
hook_receipt_root="$hook_receipt_home/.codex"
mkdir -p "$hook_receipt_root/opcore"
printf 'not owned\n' > "$hook_receipt_root/opcore/hook-install.json"
if HOME="$hook_receipt_home" CODEX_HOME="$hook_receipt_root" \
  OPCORE_BIN_DIR="$hook_receipt_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" \
    >"$fixture/unowned-hook-receipt-output" 2>&1; then
  printf 'unowned hook receipt unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'refusing to adopt an unowned hook receipt' \
  "$fixture/unowned-hook-receipt-output" >/dev/null
test ! -e "$hook_receipt_home/bin/opcore"

symlink_home="$fixture/symlink collision user"
symlink_bin="$symlink_home/bin"
symlink_target="$fixture/symlink target directory"
mkdir -p "$symlink_bin" "$symlink_target"
ln -s "$symlink_target" "$symlink_bin/opcore"
if HOME="$symlink_home" CODEX_HOME="$symlink_home/.codex" \
  OPCORE_BIN_DIR="$symlink_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --force \
    >"$fixture/symlink-collision-output" 2>&1; then
  printf 'symlinked binary destination unexpectedly accepted with --force\n' >&2
  exit 1
fi
grep -F 'refusing to replace symlinked binary' \
  "$fixture/symlink-collision-output" >/dev/null
test -L "$symlink_bin/opcore"
test -z "$(find "$symlink_target" -mindepth 1 -print -quit)"

managed_skill_home="$fixture/managed skill symlink user"
managed_skill_target="$fixture/managed skill target"
mkdir -p "$managed_skill_home/.agents/skills" "$managed_skill_target"
ln -s "$managed_skill_target" "$managed_skill_home/.agents/skills/opcore"
if HOME="$managed_skill_home" CODEX_HOME="$managed_skill_home/.codex" \
  OPCORE_BIN_DIR="$managed_skill_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --force \
    >"$fixture/managed-skill-output" 2>&1; then
  printf 'symlinked managed skill directory unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'refusing symlinked managed skill directory' \
  "$fixture/managed-skill-output" >/dev/null
test -z "$(find "$managed_skill_target" -mindepth 1 -print -quit)"
test ! -e "$managed_skill_home/bin/opcore"

managed_runtime_home="$fixture/managed runtime symlink user"
managed_runtime_target="$fixture/managed runtime target"
mkdir -p "$managed_runtime_home/.codex" "$managed_runtime_target"
ln -s "$managed_runtime_target" "$managed_runtime_home/.codex/opcore"
if HOME="$managed_runtime_home" CODEX_HOME="$managed_runtime_home/.codex" \
  OPCORE_BIN_DIR="$managed_runtime_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --force \
    >"$fixture/managed-runtime-output" 2>&1; then
  printf 'symlinked managed runtime directory unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'refusing symlinked managed runtime directory' \
  "$fixture/managed-runtime-output" >/dev/null
test -z "$(find "$managed_runtime_target" -mindepth 1 -print -quit)"
test ! -e "$managed_runtime_home/bin/opcore"

managed_descriptor_home="$fixture/managed descriptor symlink user"
managed_descriptor_target="$fixture/managed descriptor target"
mkdir -p \
  "$managed_descriptor_home/.agents/skills/opcore" \
  "$managed_descriptor_target"
ln -s \
  "$managed_descriptor_target" \
  "$managed_descriptor_home/.agents/skills/opcore/agents"
if HOME="$managed_descriptor_home" CODEX_HOME="$managed_descriptor_home/.codex" \
  OPCORE_BIN_DIR="$managed_descriptor_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --force \
    >"$fixture/managed-descriptor-output" 2>&1; then
  printf 'symlinked managed descriptor directory unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'refusing symlinked managed skill-descriptor directory' \
  "$fixture/managed-descriptor-output" >/dev/null
test -z "$(find "$managed_descriptor_target" -mindepth 1 -print -quit)"
test ! -e "$managed_descriptor_home/bin/opcore"

HOME="$codex_home" \
CODEX_HOME="$codex_root" \
OPCORE_BIN_DIR="$codex_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >"$install_output"

test -x "$codex_bin/opcore"
printf -v codex_command '%q' "$codex_bin/opcore"
grep -F "$codex_command run post-edit --repo . --json" \
  "$codex_home/.agents/skills/opcore/SKILL.md" >/dev/null
grep -F 'all selected uncommitted worktree changes against HEAD' \
  "$codex_home/.agents/skills/opcore/SKILL.md" >/dev/null
grep -F 'While an intervention remains unresolved' \
  "$codex_home/.agents/skills/opcore/SKILL.md" >/dev/null
for guidance in \
  targets.exclude \
  dedup_region_file_limit \
  importantFanIn \
  publicSurfaceAuthoritative \
  documentationCoverage.evaluated \
  not_read \
  'https://the-open-engine.github.io/opcore/dev/docs/configuration.html#select-targets' \
  'https://the-open-engine.github.io/opcore/dev/docs/sense.html#dependency-envelope'; do
  grep -F "$guidance" "$codex_home/.agents/skills/opcore/SKILL.md" >/dev/null
done
if grep -F '`opcore check' \
  "$codex_home/.agents/skills/opcore/SKILL.md" >/dev/null; then
  printf 'installed Codex skill still depends on PATH\n' >&2
  exit 1
fi
env -i HOME="$codex_home" PATH=/usr/bin:/bin \
  /bin/bash --noprofile --norc -c "$codex_command --version" >/dev/null
cmp \
  "$repo_root/skills/opcore/agents/openai.yaml" \
  "$codex_home/.agents/skills/opcore/agents/openai.yaml"
test -x "$codex_root/opcore/uninstall.sh"
grep -F 'opcore.install.v6' "$codex_root/opcore/install.receipt" >/dev/null
grep -F 'agent codex' "$codex_root/opcore/install.receipt" >/dev/null
grep -F 'owners_path ' "$codex_root/opcore/install.receipt" >/dev/null
grep -F 'installer ' "$codex_root/opcore/install.receipt" >/dev/null
grep -F 'binary_path ' "$codex_root/opcore/install.receipt" >/dev/null
grep -F 'skill_path ' "$codex_root/opcore/install.receipt" >/dev/null
grep -F 'hooks yes' "$codex_root/opcore/install.receipt" >/dev/null
grep -F '"PostToolUse"' "$codex_root/hooks.json" >/dev/null
grep -F 'opcore agent-gate' "$codex_root/hooks.json" >/dev/null
grep -F 'Running Opcore Verify and Project Sense' \
  "$codex_root/hooks.json" >/dev/null
test -f "$codex_root/opcore/hook-install.json"
grep -F "\"bin\": \"$codex_bin/opcore\"" \
  "$codex_root/opcore/asp-server.json" >/dev/null
grep -F '"id": "opcore-rust-native"' \
  "$codex_root/opcore/asp-server-rust-native.json" >/dev/null
grep -F '"id": "opcore-node-native"' \
  "$codex_root/opcore/asp-server-node-native.json" >/dev/null
grep -F '"id": "opcore-python-native"' \
  "$codex_root/opcore/asp-server-python-native.json" >/dev/null
if grep -F "\"\$schema\"" "$codex_root/opcore/asp-server.json" >/dev/null; then
  printf 'generated manifest still links the removed remote schema\n' >&2
  exit 1
fi
grep -F 'verified opcore ' "$install_output" >/dev/null
grep -F 'export PATH=' "$install_output" >/dev/null
grep -F 'uninstall with:' "$install_output" >/dev/null
"$codex_bin/opcore" --version >/dev/null

HOME="$codex_home" \
CODEX_HOME="$codex_root" \
OPCORE_BIN_DIR="$codex_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >/dev/null
test "$(find "$codex_root" -type f | wc -l | tr -d ' ')" -eq 8
test "$(find "$codex_home/.agents/skills/opcore" -type f | wc -l | tr -d ' ')" -eq 2
test -z "$(
  find "$codex_home" -type f \
    \( -name '.opcore.*' -o -name '.SKILL.md.*' -o -name '.openai.yaml.*' -o \
       -name '.asp-server.json.*' -o -name '.asp-server-rust-native.json.*' -o \
       -name '.asp-server-node-native.json.*' -o \
       -name '.asp-server-python-native.json.*' -o -name '.install.receipt.*' \) \
    -print -quit
)"

binary_digest=$(file_digest "$codex_bin/opcore")
manifest_digest=$(file_digest "$codex_root/opcore/asp-server.json")
receipt_digest=$(file_digest "$codex_root/opcore/install.receipt")
printf '%s\n' 'not an executable' > "$fixture/invalid-binary"
if HOME="$codex_home" CODEX_HOME="$codex_root" OPCORE_BIN_DIR="$codex_bin" \
  "$repo_root/scripts/install.sh" --binary "$fixture/invalid-binary" >/dev/null 2>&1; then
  printf 'invalid binary unexpectedly installed\n' >&2
  exit 1
fi
test "$(file_digest "$codex_bin/opcore")" = "$binary_digest"
test "$(file_digest "$codex_root/opcore/asp-server.json")" = "$manifest_digest"
test "$(file_digest "$codex_root/opcore/install.receipt")" = "$receipt_digest"

if HOME="$codex_home" CODEX_HOME="$codex_root" \
  OPCORE_BIN_DIR="$codex_home/other-bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >"$fixture/path-change" 2>&1; then
  printf 'destination-changing update unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'binary-destination changed since the prior install' "$fixture/path-change" >/dev/null
test ! -e "$codex_home/other-bin/opcore"

no_hook_home="$fixture/no hook user"
no_hook_root="$no_hook_home/.codex"
no_hook_bin="$no_hook_home/bin"
HOME="$no_hook_home" CODEX_HOME="$no_hook_root" OPCORE_BIN_DIR="$no_hook_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --no-hooks >/dev/null
grep -F 'hooks no' "$no_hook_root/opcore/install.receipt" >/dev/null
test ! -e "$no_hook_root/hooks.json"
test ! -e "$no_hook_root/opcore/hook-install.json"
HOME="$fixture/unrelated no hook home" \
  "$no_hook_root/opcore/uninstall.sh" --uninstall >/dev/null
test ! -e "$no_hook_bin/opcore"

saved_skill_dir="$fixture/original installed skill"
alternate_skill_dir="$fixture/alternate installed skill"
mv "$codex_home/.agents/skills/opcore" "$saved_skill_dir"
cp -R "$saved_skill_dir" "$alternate_skill_dir"
ln -s "$alternate_skill_dir" "$codex_home/.agents/skills/opcore"
if HOME="$fixture/unrelated retarget home" \
  "$codex_root/opcore/uninstall.sh" --uninstall \
    >"$fixture/retargeted-skill-output" 2>&1; then
  printf 'retargeted managed skill directory unexpectedly uninstalled\n' >&2
  exit 1
fi
grep -F 'refusing symlinked managed skill directory' \
  "$fixture/retargeted-skill-output" >/dev/null
test -f "$saved_skill_dir/SKILL.md"
test -f "$alternate_skill_dir/SKILL.md"
test -x "$codex_bin/opcore"
rm -f -- "$codex_home/.agents/skills/opcore"
mv "$saved_skill_dir" "$codex_home/.agents/skills/opcore"

collision_home="$fixture/collision user"
collision_bin="$collision_home/bin"
install -d "$collision_bin"
printf 'mine\n' > "$collision_bin/opcore"
if HOME="$collision_home" CODEX_HOME="$collision_home/.codex" \
  OPCORE_BIN_DIR="$collision_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >"$fixture/collision-output" 2>&1; then
  printf 'unowned collision unexpectedly replaced\n' >&2
  exit 1
fi
grep -F 'refusing to replace unowned binary' "$fixture/collision-output" >/dev/null
grep -Fx 'mine' "$collision_bin/opcore" >/dev/null
HOME="$collision_home" CODEX_HOME="$collision_home/.codex" \
OPCORE_BIN_DIR="$collision_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --force >/dev/null
test -x "$collision_bin/opcore"
HOME="$collision_home" CODEX_HOME="$collision_home/.codex" \
OPCORE_BIN_DIR="$collision_bin" \
  "$collision_home/.codex/opcore/uninstall.sh" --uninstall >/dev/null

backslash_home="$fixture/backslash\\ user"
backslash_logical_home="$fixture/backslash logical home"
mkdir -p "$backslash_home"
ln -s "$backslash_home" "$backslash_logical_home"
backslash_root="$backslash_home/.codex"
backslash_bin="$backslash_home/bin"
HOME="$backslash_logical_home" CODEX_HOME="$backslash_logical_home/.codex" \
OPCORE_BIN_DIR="$backslash_logical_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >/dev/null
HOME="$backslash_logical_home" CODEX_HOME="$backslash_logical_home/.codex" \
OPCORE_BIN_DIR="$backslash_logical_home/bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >/dev/null
grep -E '^binary [0-9a-f]{64}$' "$backslash_root/opcore/install.receipt" >/dev/null
HOME="$backslash_logical_home" CODEX_HOME="$backslash_logical_home/.codex" \
OPCORE_BIN_DIR="$backslash_logical_home/bin" \
  "$repo_root/scripts/install.sh" --uninstall >/dev/null
test ! -e "$backslash_bin/opcore"
test ! -e "$backslash_home/.agents/skills/opcore/SKILL.md"

claude_home="$fixture/claude user"
claude_root="$claude_home/.claude"
claude_bin="$claude_home/bin"
HOME="$claude_home" CLAUDE_CONFIG_DIR="$claude_root" \
  "$repo_root/scripts/install.sh" \
    --agent claude \
    --bin-dir "$claude_bin" \
    --binary "$binary" >/dev/null
test -x "$claude_bin/opcore"
printf -v claude_command '%q' "$claude_bin/opcore"
grep -F "$claude_command run post-edit --repo . --json" \
  "$claude_root/skills/opcore/SKILL.md" >/dev/null
grep -F 'all selected uncommitted worktree changes against HEAD' \
  "$claude_root/skills/opcore/SKILL.md" >/dev/null
grep -F 'While an intervention remains unresolved' \
  "$claude_root/skills/opcore/SKILL.md" >/dev/null
grep -F '"PostToolUse"' "$claude_root/settings.json" >/dev/null
grep -F 'opcore agent-gate' "$claude_root/settings.json" >/dev/null
grep -F 'hooks yes' "$claude_root/opcore/install.receipt" >/dev/null
printf '\nmodified\n' >> "$claude_root/opcore/asp-server-rust-native.json"
if HOME="$claude_home" CLAUDE_CONFIG_DIR="$claude_root" \
  "$claude_root/opcore/uninstall.sh" \
    --uninstall --agent claude --bin-dir "$claude_bin" >/dev/null 2>&1; then
  printf 'incomplete uninstall unexpectedly returned success\n' >&2
  exit 1
fi
test -f "$claude_root/opcore/asp-server-rust-native.json"
test -f "$claude_root/opcore/install.receipt"
test -x "$claude_root/opcore/uninstall.sh"
test -e "$claude_root/opcore/asp-server.json"
test -e "$claude_root/opcore/asp-server-node-native.json"
test -e "$claude_root/opcore/asp-server-python-native.json"
test -e "$claude_bin/opcore"
test -e "$claude_root/settings.json"

legacy_home="$fixture/legacy user"
legacy_root="$legacy_home/.codex"
legacy_bin="$legacy_home/bin"
HOME="$legacy_home" CODEX_HOME="$legacy_root" OPCORE_BIN_DIR="$legacy_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >/dev/null
legacy_receipt="$legacy_root/opcore/install.receipt"
# Historical installs predate shared ownership records.
rm -rf -- "$legacy_home/.local/share/opcore/owners"
install -d "$legacy_root/skills"
mv "$legacy_home/.agents/skills/opcore" "$legacy_root/skills/opcore"
legacy_receipt_temporary="$legacy_root/opcore/.install.receipt.v3"
awk '
  NR == 1 { print "opcore.install.v3"; next }
  $1 != "agent" && $1 != "installer" && $1 !~ /_path$/ { print }
' "$legacy_receipt" > "$legacy_receipt_temporary"
mv -f -- "$legacy_receipt_temporary" "$legacy_receipt"
rm -f -- "$legacy_root/opcore/uninstall.sh"
HOME="$legacy_home" CODEX_HOME="$legacy_root" OPCORE_BIN_DIR="$legacy_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" >/dev/null
test ! -e "$legacy_root/skills/opcore/SKILL.md"
test -e "$legacy_home/.agents/skills/opcore/SKILL.md"
grep -F 'opcore.install.v6' "$legacy_receipt" >/dev/null
HOME="$fixture/unrelated legacy home" \
  "$legacy_root/opcore/uninstall.sh" --uninstall >/dev/null
test ! -e "$legacy_root/opcore/install.receipt"
test ! -e "$legacy_root/opcore/asp-server.json"
test ! -e "$legacy_bin/opcore"
test ! -e "$legacy_home/.agents/skills/opcore/SKILL.md"

pending_home="$fixture/pending hook user"
pending_root="$pending_home/.codex"
pending_bin="$pending_home/bin"
mkdir -p "$pending_root/hooks.json"
if HOME="$pending_home" CODEX_HOME="$pending_root" OPCORE_BIN_DIR="$pending_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --hooks \
    >"$fixture/pending-hook-output" 2>&1; then
  printf 'invalid hook config unexpectedly installed\n' >&2
  exit 1
fi
test ! -e "$pending_root/opcore/install.receipt"
test ! -e "$pending_bin/opcore"
rmdir "$pending_root/hooks.json"
HOME="$pending_home" CODEX_HOME="$pending_root" OPCORE_BIN_DIR="$pending_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --hooks >/dev/null
grep -F 'hooks yes' "$pending_root/opcore/install.receipt" >/dev/null
HOME="$fixture/unrelated pending home" \
  "$pending_root/opcore/uninstall.sh" --uninstall >/dev/null
test ! -e "$pending_bin/opcore"
test ! -e "$pending_root/hooks.json"

hook_home="$fixture/hook user"
hook_root="$hook_home/.codex"
hook_bin="$hook_home/bin"
HOME="$hook_home" CODEX_HOME="$hook_root" OPCORE_BIN_DIR="$hook_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" --hooks >"$fixture/hook-output"
grep -F '"PostToolUse"' "$hook_root/hooks.json" >/dev/null
grep -F 'opcore agent-gate' "$hook_root/hooks.json" >/dev/null
grep -F 'open /hooks' "$fixture/hook-output" >/dev/null
test -f "$hook_root/opcore/hook-install.json"
cp "$hook_root/opcore/hook-install.json" "$fixture/symlink-hook-receipt"
rm -f -- "$hook_root/opcore/hook-install.json"
ln -s "$fixture/symlink-hook-receipt" "$hook_root/opcore/hook-install.json"
if HOME="$hook_home" CODEX_HOME="$hook_root" OPCORE_BIN_DIR="$hook_bin" \
  "$repo_root/scripts/install.sh" --binary "$binary" \
    >"$fixture/symlink-hook-receipt-output" 2>&1; then
  printf 'symlinked hook receipt unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'hook ownership receipt path is not a regular file' \
  "$fixture/symlink-hook-receipt-output" >/dev/null
rm -f -- "$hook_root/opcore/hook-install.json"
cp "$fixture/symlink-hook-receipt" "$hook_root/opcore/hook-install.json"
mv "$hook_root/opcore/hook-install.json" "$fixture/saved-hook-receipt"
if HOME="$fixture/unrelated hook home" \
  "$hook_root/opcore/uninstall.sh" --uninstall >"$fixture/missing-hook-receipt" 2>&1; then
  printf 'missing hook receipt unexpectedly allowed uninstall\n' >&2
  exit 1
fi
grep -F 'ownership receipt is missing' "$fixture/missing-hook-receipt" >/dev/null
test -x "$hook_bin/opcore"
test -e "$hook_root/hooks.json"
mv "$fixture/saved-hook-receipt" "$hook_root/opcore/hook-install.json"
printf '%s\n' '#!/usr/bin/env bash' "printf ran > '$fixture/modified-binary-ran'" \
  > "$hook_bin/opcore"
chmod 0755 "$hook_bin/opcore"
if HOME="$fixture/unrelated hook home" \
  "$hook_root/opcore/uninstall.sh" --uninstall >"$fixture/unsafe-uninstall" 2>&1; then
  printf 'modified hook binary was accepted during uninstall\n' >&2
  exit 1
fi
grep -F 'refusing to execute a missing or modified installed binary' \
  "$fixture/unsafe-uninstall" >/dev/null
test ! -e "$fixture/modified-binary-ran"
test -e "$hook_root/hooks.json"
rm -f -- "$hook_bin/opcore"
wrong_control_binary="$fixture/wrong control binary"
printf '%s\n' '#!/bin/sh' "printf '%s\\n' 'not-opcore 1.0'" > "$wrong_control_binary"
chmod 0755 "$wrong_control_binary"
if HOME="$fixture/unrelated hook home" \
  "$hook_root/opcore/uninstall.sh" --uninstall --binary "$wrong_control_binary" \
    >"$fixture/wrong-control-binary" 2>&1; then
  printf 'non-opcore hook control binary unexpectedly accepted\n' >&2
  exit 1
fi
grep -F 'did not identify itself as opcore' "$fixture/wrong-control-binary" >/dev/null
test -e "$hook_root/hooks.json"
HOME="$fixture/unrelated hook home" \
  "$hook_root/opcore/uninstall.sh" --uninstall --binary "$binary" >/dev/null
test ! -e "$hook_root/hooks.json"
test ! -e "$hook_root/opcore/hook-install.json"
test ! -e "$hook_root/opcore/install.receipt"
test ! -e "$hook_root/opcore/asp-server.json"
test ! -e "$hook_root/opcore/asp-server-rust-native.json"
test ! -e "$hook_root/opcore/asp-server-node-native.json"
test ! -e "$hook_root/opcore/asp-server-python-native.json"
test ! -e "$hook_root/opcore/uninstall.sh"
test ! -e "$hook_home/.agents/skills/opcore/SKILL.md"
test ! -e "$hook_bin/opcore"

printf 'installer test passed\n'

"$repo_root/scripts/test-install-multi.sh" "$binary"
