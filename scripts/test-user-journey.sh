#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
archive=${1:?usage: scripts/test-user-journey.sh /path/to/opcore-vVERSION-PLATFORM.tar.gz}
archive_dir=$(cd -- "$(dirname -- "$archive")" && pwd -P)
archive="$archive_dir/$(basename -- "$archive")"
archive_name=$(basename -- "$archive")
case "$archive_name" in
  opcore-v*-linux-x86_64.tar.gz)
    platform=linux-x86_64
    ;;
  opcore-v*-macos-arm64.tar.gz)
    platform=macos-arm64
    ;;
  *)
    printf 'user journey: unexpected archive name %s\n' "$archive_name" >&2
    exit 1
    ;;
esac
release_version=${archive_name#opcore-v}
release_version=${release_version%-"$platform".tar.gz}
if [[ ! "$release_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'user journey: unexpected release version in %s\n' "$archive_name" >&2
  exit 1
fi
bundle_name="opcore-$platform"

temp_root=${TMPDIR:-/tmp}
fixture=$(mktemp -d "$temp_root/opcore journey.XXXXXX")
fixture=$(cd -- "$fixture" && pwd -P)
trap 'rm -rf -- "$fixture"' EXIT
extract_dir="$fixture/extracted files"
install_home="$fixture/user home"
codex_root="$fixture/codex config"
bin_dir="$fixture/user bin"
project="$fixture/sample project"
rust_project="$fixture/rust project"
mkdir -p "$extract_dir"

if ! tar -tzf "$archive" | awk -F/ -v root="$bundle_name" '$1 != root { exit 1 }'; then
  printf 'user journey: archive has an entry outside %s\n' "$bundle_name" >&2
  exit 1
fi
tar -xzf "$archive" -C "$extract_dir"
bundle_root="$extract_dir/$bundle_name"
for path in \
  install.sh \
  bin/opcore \
  opcore.sha256 \
  skills/opcore/SKILL.md \
  skills/opcore/agents/openai.yaml \
  asp/SOURCE.json \
  docs/assets/opcore-hook-loop.svg \
  docs/assets/opcore-hook-loop-mobile.svg \
  docs/assets/asp-overview.svg \
  docs/assets/asp-overview-mobile.svg \
  LICENSE \
  README.md; do
  test -f "$bundle_root/$path"
done
test -x "$bundle_root/install.sh"
test -x "$bundle_root/bin/opcore"
grep -E '^[0-9a-f]{64}  bin/opcore$' "$bundle_root/opcore.sha256" >/dev/null
test -z "$(find "$bundle_root/asp" -type f -perm -022 -print -quit)"
test -z "$(find "$bundle_root/asp" -type d -perm -022 -print -quit)"

collision_dist="$fixture/collision dist"
collision_output="$fixture/collision output"
mkdir -p "$collision_dist" "$collision_output/$archive_name"
install -m 0755 "$bundle_root/bin/opcore" "$collision_dist/opcore"
read -r collision_digest _ < "$bundle_root/opcore.sha256"
printf '%s  opcore\n' "$collision_digest" > "$collision_dist/opcore.sha256"
for profile in fast rust-native node-native python-native; do
  case "$profile" in
    fast) manifest_name=asp-server.json ;;
    *) manifest_name="asp-server-$profile.json" ;;
  esac
  "$collision_dist/opcore" manifest \
    --profile "$profile" \
    --executable "$collision_dist/opcore" > "$collision_dist/$manifest_name"
done
if "$repo_root/scripts/bundle-release.sh" "$collision_dist" "$collision_output" \
  >"$fixture/archive-directory-output" 2>&1; then
  printf 'user journey: bundle replaced an archive destination directory\n' >&2
  exit 1
fi
grep -F 'archive destination is not a regular file' \
  "$fixture/archive-directory-output" >/dev/null
test -z "$(find "$collision_output/$archive_name" -mindepth 1 -print -quit)"
rmdir "$collision_output/$archive_name"
printf 'owned elsewhere\n' > "$fixture/archive-symlink-target"
ln -s "$fixture/archive-symlink-target" "$collision_output/$archive_name"
if "$repo_root/scripts/bundle-release.sh" "$collision_dist" "$collision_output" \
  >"$fixture/archive-symlink-output" 2>&1; then
  printf 'user journey: bundle replaced an archive destination symlink\n' >&2
  exit 1
fi
grep -F 'archive destination is not a regular file' \
  "$fixture/archive-symlink-output" >/dev/null
grep -Fx 'owned elsewhere' "$fixture/archive-symlink-target" >/dev/null

failure_tools="$fixture/failure tools"
failure_output="$fixture/mktemp failure output"
mkdir -p "$failure_tools" "$failure_output"
real_mktemp=$(command -v mktemp)
# shellcheck disable=SC2016 # These variables belong to the generated failure helper.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'count=0' \
  'if [[ -f "$OPCORE_TEST_MKTEMP_COUNT" ]]; then' \
  '  read -r count < "$OPCORE_TEST_MKTEMP_COUNT"' \
  'fi' \
  'count=$((count + 1))' \
  'printf "%s\\n" "$count" > "$OPCORE_TEST_MKTEMP_COUNT"' \
  'if ((count == 2)); then exit 70; fi' \
  'exec "$OPCORE_TEST_REAL_MKTEMP" "$@"' > "$failure_tools/mktemp"
chmod 0755 "$failure_tools/mktemp"
if PATH="$failure_tools:$PATH" \
  OPCORE_TEST_MKTEMP_COUNT="$fixture/mktemp-count" \
  OPCORE_TEST_REAL_MKTEMP="$real_mktemp" \
  "$repo_root/scripts/bundle-release.sh" "$collision_dist" "$failure_output" \
    >"$fixture/mktemp-failure-output" 2>&1; then
  printf 'user journey: injected archive staging failure unexpectedly passed\n' >&2
  exit 1
fi
test -z "$(find "$failure_output" -mindepth 1 -print -quit)"

term_tools="$fixture/term tools"
term_output="$fixture/term output"
mkdir -p "$term_tools" "$term_output"
# shellcheck disable=SC2016 # PPID belongs to the generated signal helper.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'kill -TERM "$PPID"' \
  'sleep 1' \
  'exit 0' > "$term_tools/tar"
chmod 0755 "$term_tools/tar"
set +e
PATH="$term_tools:$PATH" \
  "$repo_root/scripts/bundle-release.sh" "$collision_dist" "$term_output" \
    >"$fixture/term-output" 2>&1
term_status=$?
set -e
test "$term_status" -eq 143
test -z "$(find "$term_output" -mindepth 1 -print -quit)"

corrupt_root="$fixture/corrupt bundle"
cp -R "$bundle_root" "$corrupt_root"
printf 'corrupt\n' >> "$corrupt_root/bin/opcore"
if HOME="$fixture/corrupt home" CODEX_HOME="$fixture/corrupt codex" \
  OPCORE_BIN_DIR="$fixture/corrupt bin" PATH=/usr/bin:/bin \
  "$corrupt_root/install.sh" --agent codex >"$fixture/corrupt-output" 2>&1; then
  printf 'user journey: corrupt bundled binary unexpectedly installed\n' >&2
  exit 1
fi
grep -F 'bundled binary checksum does not match' "$fixture/corrupt-output" >/dev/null
test ! -e "$fixture/corrupt bin/opcore"

damaged_parent="$fixture/outer Rust project"
mkdir -p "$damaged_parent"
printf '%s\n' '[workspace]' > "$damaged_parent/Cargo.toml"
missing_binary_root="$damaged_parent/missing binary"
cp -R "$bundle_root" "$missing_binary_root"
rm -f -- "$missing_binary_root/bin/opcore"
if HOME="$fixture/missing binary home" CODEX_HOME="$fixture/missing binary codex" \
  OPCORE_BIN_DIR="$fixture/missing binary bin" \
  "$missing_binary_root/install.sh" --agent codex >"$fixture/missing-binary-output" 2>&1; then
  printf 'user journey: bundle with no binary unexpectedly installed\n' >&2
  exit 1
fi
grep -F 'bundled binary is missing' "$fixture/missing-binary-output" >/dev/null
missing_checksum_root="$damaged_parent/missing checksum"
cp -R "$bundle_root" "$missing_checksum_root"
rm -f -- "$missing_checksum_root/opcore.sha256"
if HOME="$fixture/missing checksum home" CODEX_HOME="$fixture/missing checksum codex" \
  OPCORE_BIN_DIR="$fixture/missing checksum bin" \
  "$missing_checksum_root/install.sh" --agent codex >"$fixture/missing-checksum-output" 2>&1; then
  printf 'user journey: bundle with no checksum unexpectedly installed\n' >&2
  exit 1
fi
grep -F 'bundled checksum is missing' "$fixture/missing-checksum-output" >/dev/null
missing_skill_root="$damaged_parent/missing skill"
cp -R "$bundle_root" "$missing_skill_root"
rm -f -- "$missing_skill_root/skills/opcore/SKILL.md"
if HOME="$fixture/missing skill home" CODEX_HOME="$fixture/missing skill codex" \
  OPCORE_BIN_DIR="$fixture/missing skill bin" \
  "$missing_skill_root/install.sh" --agent codex >"$fixture/missing-skill-output" 2>&1; then
  printf 'user journey: bundle with no skill unexpectedly installed\n' >&2
  exit 1
fi
grep -F 'bundled agent skill is missing' "$fixture/missing-skill-output" >/dev/null
test ! -e "$fixture/missing skill bin/opcore"
missing_descriptor_root="$damaged_parent/missing descriptor"
cp -R "$bundle_root" "$missing_descriptor_root"
rm -f -- "$missing_descriptor_root/skills/opcore/agents/openai.yaml"
if HOME="$fixture/missing descriptor home" CODEX_HOME="$fixture/missing descriptor codex" \
  OPCORE_BIN_DIR="$fixture/missing descriptor bin" \
  "$missing_descriptor_root/install.sh" --agent codex \
    >"$fixture/missing-descriptor-output" 2>&1; then
  printf 'user journey: bundle with no Codex descriptor unexpectedly installed\n' >&2
  exit 1
fi
grep -F 'bundled Codex skill descriptor is missing' \
  "$fixture/missing-descriptor-output" >/dev/null
test ! -e "$fixture/missing descriptor bin/opcore"

HOME="$install_home" CODEX_HOME="$codex_root" OPCORE_BIN_DIR="$bin_dir" \
PATH=/usr/bin:/bin \
  "$bundle_root/install.sh" --agent codex >"$fixture/install-output"
installed="$bin_dir/opcore"
test -x "$installed"
test -x "$codex_root/opcore/uninstall.sh"
test -f "$install_home/.agents/skills/opcore/SKILL.md"
printf -v installed_command '%q' "$installed"
grep -F "$installed_command run post-edit --repo . --json" \
  "$install_home/.agents/skills/opcore/SKILL.md" >/dev/null
env -i HOME="$install_home" PATH=/usr/bin:/bin \
  /bin/bash --noprofile --norc -c "$installed_command --version" >/dev/null
grep -F 'verified opcore ' "$fixture/install-output" >/dev/null
grep -F 'export PATH=' "$fixture/install-output" >/dev/null
grep -F 'open /hooks' "$fixture/install-output" >/dev/null
grep -F 'opcore agent-gate' "$codex_root/hooks.json" >/dev/null
grep -F 'hooks yes' "$codex_root/opcore/install.receipt" >/dev/null

mkdir -p "$project/src"
git -C "$project" init -q
git -C "$project" config user.name Test
git -C "$project" config user.email test@example.com
printf '%s\n' \
  'export function greet(name: string): string {' \
  "  return 'hello ' + name;" \
  '}' > "$project/src/main.ts"
printf '%s\n' \
  'syntax = "proto3";' \
  'message Greeting { string text = 1; }' > "$project/src/greeting.proto"
git -C "$project" add .
git -C "$project" commit -qm baseline

env -u CLAUDE_CONFIG_DIR HOME="$install_home" CODEX_HOME="$codex_root" \
  "$installed" doctor --repo "$project" >"$fixture/doctor-output"
grep -F 'fast checks ready' "$fixture/doctor-output" >/dev/null
"$installed" check --repo "$project" --all >"$fixture/clean-output"
grep -F 'opcore: Clean' "$fixture/clean-output" >/dev/null
grep -F '2 files' "$fixture/clean-output" >/dev/null

if ! "$installed" check --repo "$project" >"$fixture/empty-output" 2>&1; then
  printf 'user journey: empty changed check unexpectedly failed\n' >&2
  exit 1
fi
grep -F 'Nothing checked (0 supported files)' "$fixture/empty-output" >/dev/null
grep -F 'check --repo . --all' "$fixture/empty-output" >/dev/null

printf '%s\n' \
  'export function crowded(a: number, b: number, c: number, d: number, e: number, f: number): number {' \
  '  return a + b + c + d + e + f;' \
  '}' > "$project/src/main.ts"
if "$installed" check --repo "$project" >"$fixture/finding-output" 2>&1; then
  printf 'user journey: parameter finding unexpectedly passed\n' >&2
  exit 1
fi
grep -F 'function parameters' "$fixture/finding-output" >/dev/null
git -C "$project" reset --hard -q HEAD

if ! "$installed" sense --repo "$project" >"$fixture/partial-output" 2>&1; then
  printf 'user journey: empty partial Sense result unexpectedly failed\n' >&2
  exit 1
fi
grep -F 'baseline coverage remains partial' "$fixture/partial-output" >/dev/null
"$installed" sense --repo "$project" --allow-partial >/dev/null

printf '%s\n' \
  'syntax = "proto3";' \
  'message Greeting { string text = 1; string language = 2; }' \
  > "$project/src/greeting.proto"
if ! printf '{"hook_event_name":"PostToolUse","cwd":"%s"}\n' "$project" | \
  "$installed" agent-gate >"$fixture/hook-partial-stdout" \
    2>"$fixture/hook-partial-stderr"; then
  printf 'user journey: partial Sense hook result unexpectedly blocked\n' >&2
  exit 1
fi
test ! -s "$fixture/hook-partial-stdout"
# The command in hook feedback is intentionally literal.
# shellcheck disable=SC2016
grep -Fx \
  'Project Sense coverage is partial. Run `opcore run post-edit --repo . --json` for details.' \
  "$fixture/hook-partial-stderr" >/dev/null
if grep -F 'unsupported' "$fixture/hook-partial-stderr" >/dev/null; then
  printf 'user journey: hook leaked unsupported-coverage details\n' >&2
  exit 1
fi
git -C "$project" reset --hard -q HEAD

printf '%s\n' \
  "import { b } from './b';" \
  'export const a = b + 1;' > "$project/src/a.ts"
printf '%s\n' 'export const b = 1;' > "$project/src/b.ts"
git -C "$project" add .
git -C "$project" commit -qm graph-baseline
printf '%s\n' \
  "import { a } from './a';" \
  'export const b = a + 1;' > "$project/src/b.ts"
if printf '{"hook_event_name":"PostToolUse","cwd":"%s"}\n' "$project" | \
  "$installed" agent-gate >"$fixture/hook-sense-stdout" \
    2>"$fixture/hook-sense-stderr"; then
  printf 'user journey: confirmed Sense finding unexpectedly passed the hook\n' >&2
  exit 1
fi
test ! -s "$fixture/hook-sense-stdout"
grep -F 'sense.runtime_cycle' "$fixture/hook-sense-stderr" >/dev/null
grep -F 'Project Sense coverage is partial' "$fixture/hook-sense-stderr" >/dev/null
git -C "$project" reset --hard -q HEAD

mkdir -p "$rust_project/src"
git -C "$rust_project" init -q
git -C "$rust_project" config user.name Test
git -C "$rust_project" config user.email test@example.com
printf '%s\n' \
  '[package]' \
  'name = "journey-fixture"' \
  'version = "0.1.0"' \
  'edition = "2024"' > "$rust_project/Cargo.toml"
printf '%s\n' 'pub fn answer() -> u32 { 42 }' > "$rust_project/src/lib.rs"
git -C "$rust_project" add .
git -C "$rust_project" commit -qm baseline
fake_cargo="$fixture/fake-cargo"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  "printf ran > '$fixture/fake-cargo-ran'" > "$fake_cargo"
chmod 0755 "$fake_cargo"
if OPCORE_CARGO="$fake_cargo" \
  "$installed" check --repo "$rust_project" --providers rust-native \
    >"$fixture/consent-output" 2>&1; then
  printf 'user journey: native provider ran without consent\n' >&2
  exit 1
fi
grep -F -- '--allow-unsandboxed-native' "$fixture/consent-output" >/dev/null
test ! -e "$fixture/fake-cargo-ran"
printf '%s\n' 'pub fn answer() -> u32 { 43 }' > "$rust_project/src/lib.rs"
OPCORE_CARGO=$(command -v cargo) \
  "$installed" check --repo "$rust_project" --providers rust-native \
    --allow-unsandboxed-native >"$fixture/native-output" 2>"$fixture/native-warning"
grep -F 'opcore host: allow' "$fixture/native-output" >/dev/null
grep -F 'advisory execution boundary' "$fixture/native-output" >/dev/null

HOME="$fixture/unrelated home" \
  "$codex_root/opcore/uninstall.sh" --uninstall >/dev/null
test ! -e "$installed"
test ! -e "$codex_root/hooks.json"
test ! -e "$codex_root/opcore/install.receipt"
test ! -e "$codex_root/opcore/uninstall.sh"
test ! -e "$install_home/.agents/skills/opcore/SKILL.md"

printf 'release user journey passed\n'
