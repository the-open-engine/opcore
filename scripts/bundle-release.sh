#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
dist_dir=${1:?usage: scripts/bundle-release.sh DIST_DIR OUTPUT_DIR}
output_dir=${2:?usage: scripts/bundle-release.sh DIST_DIR OUTPUT_DIR}

case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    platform=linux-x86_64
    ;;
  Linux:aarch64 | Linux:arm64)
    platform=linux-arm64
    ;;
  Darwin:x86_64)
    platform=macos-x86_64
    ;;
  Darwin:arm64)
    platform=macos-arm64
    ;;
  *)
    printf 'bundle-release: unsupported platform %s:%s\n' \
      "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

for name in \
  opcore \
  opcore.sha256 \
  asp-server.json \
  asp-server-rust-native.json \
  asp-server-node-native.json \
  asp-server-python-native.json; do
  [[ -f "$dist_dir/$name" ]] || {
    printf 'bundle-release: missing release file %s\n' "$dist_dir/$name" >&2
    exit 1
  }
done
[[ -f "$repo_root/asp/SOURCE.json" ]] || {
  printf 'bundle-release: missing pinned ASP definition\n' >&2
  exit 1
}
[[ -f "$repo_root/LICENSE" ]] || {
  printf 'bundle-release: missing repository license\n' >&2
  exit 1
}
[[ -f "$repo_root/README.md" ]] || {
  printf 'bundle-release: missing root README\n' >&2
  exit 1
}
for asset in \
  opcore-hook-loop.svg \
  opcore-hook-loop-mobile.svg \
  asp-overview.svg \
  asp-overview-mobile.svg; do
  [[ -f "$repo_root/docs/assets/$asset" ]] || {
    printf 'bundle-release: missing README visual %s\n' "$asset" >&2
    exit 1
  }
done
[[ -f "$repo_root/scripts/install.sh" ]] || {
  printf 'bundle-release: missing installer\n' >&2
  exit 1
}
[[ -f "$repo_root/skills/opcore/SKILL.md" ]] || {
  printf 'bundle-release: missing agent skill\n' >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
  else
    shasum -a 256 < "$1" | awk '{print $1}'
  fi
}

read -r expected_digest expected_name expected_extra < "$dist_dir/opcore.sha256"
if [[ ! "$expected_digest" =~ ^[0-9a-f]{64}$ || "$expected_name" != opcore ||
      -n ${expected_extra:-} ]]; then
  printf 'bundle-release: malformed release checksum\n' >&2
  exit 1
fi
if [[ $(sha256_file "$dist_dir/opcore") != "$expected_digest" ]]; then
  printf 'bundle-release: release binary checksum does not match\n' >&2
  exit 1
fi

mkdir -p "$output_dir"
release_identity=$("$dist_dir/opcore" --version)
case "$release_identity" in
  'opcore '[0-9]*.[0-9]*.[0-9]*) ;;
  *)
    printf 'bundle-release: binary reported an invalid release version: %s\n' \
      "$release_identity" >&2
    exit 1
    ;;
esac
release_version=${release_identity#opcore }
if [[ ! "$release_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'bundle-release: binary version is not release semver: %s\n' \
    "$release_version" >&2
  exit 1
fi
release_major=${release_version%%.*}
release_remainder=${release_version#*.}
release_minor=${release_remainder%%.*}
docs_source_base=https://the-open-engine.github.io/opcore/dev
docs_release_base=https://the-open-engine.github.io/opcore/v$release_major.$release_minor

stage_documentation_links() {
  local source=$1
  local destination=$2
  if ! grep -Fq "$docs_source_base/" "$source"; then
    printf 'bundle-release: guidance has no development documentation links: %s\n' \
      "$source" >&2
    exit 1
  fi
  if grep -Eq 'https://the-open-engine\.github\.io/opcore/v[0-9]+\.[0-9]+/' "$source"; then
    printf 'bundle-release: guidance hard-codes a release documentation minor: %s\n' \
      "$source" >&2
    exit 1
  fi
  sed "s|$docs_source_base/|$docs_release_base/|g" "$source" > "$destination"
  chmod 0644 "$destination"
  if grep -Fq "$docs_source_base/" "$destination" || \
     ! grep -Fq "$docs_release_base/" "$destination"; then
    printf 'bundle-release: failed to bind guidance to %s\n' "$docs_release_base" >&2
    exit 1
  fi
}

archive="$output_dir/opcore-v$release_version-$platform.tar.gz"
if [[ -L "$archive" || ( -e "$archive" && ! -f "$archive" ) ]]; then
  printf 'bundle-release: archive destination is not a regular file: %s\n' \
    "$archive" >&2
  exit 1
fi
bundle_name="opcore-$platform"
staging_dir=
temporary_path=
cleanup() {
  if [[ -n "$temporary_path" ]]; then
    rm -f -- "$temporary_path"
  fi
  if [[ -n "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
}
handle_signal() {
  local status=$1
  trap - HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
staging_dir=$(mktemp -d "$output_dir/.opcore-$platform.bundle.XXXXXX")
temporary_path=$(mktemp "$output_dir/.opcore-$platform.archive.XXXXXX")
bundle_root="$staging_dir/$bundle_name"
install -d \
  "$bundle_root/bin" \
  "$bundle_root/asp" \
  "$bundle_root/docs/assets" \
  "$bundle_root/skills/opcore/agents"
install -m 0755 "$repo_root/scripts/install.sh" "$bundle_root/install.sh"
install -m 0755 "$dist_dir/opcore" "$bundle_root/bin/opcore"
stage_documentation_links \
  "$repo_root/skills/opcore/SKILL.md" \
  "$bundle_root/skills/opcore/SKILL.md"
install -m 0644 \
  "$repo_root/skills/opcore/agents/openai.yaml" \
  "$bundle_root/skills/opcore/agents/openai.yaml"
cp -R "$repo_root/asp/." "$bundle_root/asp/"
find "$bundle_root/asp" -type d -exec chmod 0755 {} +
find "$bundle_root/asp" -type f -exec chmod 0644 {} +
install -m 0644 "$repo_root/LICENSE" "$bundle_root/LICENSE"
stage_documentation_links "$repo_root/README.md" "$bundle_root/README.md"
install -m 0644 "$repo_root/CONTRIBUTING.md" "$bundle_root/CONTRIBUTING.md"
for guide in \
  getting-started configuration providers examples sense agent-signals \
  architecture acceptance design-review; do
  install -m 0644 "$repo_root/docs/$guide.md" "$bundle_root/docs/$guide.md"
done
install -m 0644 \
  "$repo_root/docs/assets/opcore-hook-loop.svg" \
  "$repo_root/docs/assets/opcore-hook-loop-mobile.svg" \
  "$repo_root/docs/assets/asp-overview.svg" \
  "$repo_root/docs/assets/asp-overview-mobile.svg" \
  "$bundle_root/docs/assets/"
printf '%s  %s\n' "$expected_digest" bin/opcore > "$bundle_root/opcore.sha256"
chmod 0644 "$bundle_root/opcore.sha256"
# Manifests bind an absolute executable path, so installers regenerate all four after extraction.
tar --format=ustar -czf "$temporary_path" -C "$staging_dir" "$bundle_name"
chmod 0644 "$temporary_path"
mv -f -- "$temporary_path" "$archive"
temporary_path=
if [[ ! -f "$archive" || -L "$archive" ]]; then
  printf 'bundle-release: failed to publish the archive at its exact path\n' >&2
  exit 1
fi
rm -rf -- "$staging_dir"
staging_dir=
trap - EXIT HUP INT TERM
printf '%s\n' "$archive"
