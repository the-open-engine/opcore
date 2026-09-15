#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
target_dir=${CARGO_TARGET_DIR:-"$repo_root/target"}
dist_dir=${OPCORE_DIST_DIR:-"$repo_root/dist"}

cd "$repo_root"
cargo build --locked --release
mkdir -p "$dist_dir"
temporary_path=
native_manifest_temporary_path=
node_manifest_temporary_path=
python_manifest_temporary_path=
cleanup_temporary() {
  if [[ -n "$temporary_path" ]]; then
    rm -f -- "$temporary_path"
  fi
  if [[ -n "$native_manifest_temporary_path" ]]; then
    rm -f -- "$native_manifest_temporary_path"
  fi
  if [[ -n "$node_manifest_temporary_path" ]]; then
    rm -f -- "$node_manifest_temporary_path"
  fi
  if [[ -n "$python_manifest_temporary_path" ]]; then
    rm -f -- "$python_manifest_temporary_path"
  fi
}
trap cleanup_temporary EXIT HUP INT TERM

temporary_path=$(mktemp "$dist_dir/.opcore.XXXXXX")
install -m 0755 "$target_dir/release/opcore" "$temporary_path"
mv -f -- "$temporary_path" "$dist_dir/opcore"
temporary_path=

temporary_path=$(mktemp "$dist_dir/.asp-server.json.XXXXXX")
native_manifest_temporary_path=$(mktemp \
  "$dist_dir/.asp-server-rust-native.json.XXXXXX")
node_manifest_temporary_path=$(mktemp \
  "$dist_dir/.asp-server-node-native.json.XXXXXX")
python_manifest_temporary_path=$(mktemp \
  "$dist_dir/.asp-server-python-native.json.XXXXXX")
"$dist_dir/opcore" manifest \
  --profile fast \
  --executable "$dist_dir/opcore" > "$temporary_path"
"$dist_dir/opcore" manifest \
  --profile rust-native \
  --executable "$dist_dir/opcore" > "$native_manifest_temporary_path"
"$dist_dir/opcore" manifest \
  --profile node-native \
  --executable "$dist_dir/opcore" > "$node_manifest_temporary_path"
"$dist_dir/opcore" manifest \
  --profile python-native \
  --executable "$dist_dir/opcore" > "$python_manifest_temporary_path"
chmod 0644 \
  "$temporary_path" \
  "$native_manifest_temporary_path" \
  "$node_manifest_temporary_path" \
  "$python_manifest_temporary_path"
mv -f -- \
  "$python_manifest_temporary_path" \
  "$dist_dir/asp-server-python-native.json"
python_manifest_temporary_path=
mv -f -- \
  "$node_manifest_temporary_path" \
  "$dist_dir/asp-server-node-native.json"
node_manifest_temporary_path=
mv -f -- \
  "$native_manifest_temporary_path" \
  "$dist_dir/asp-server-rust-native.json"
native_manifest_temporary_path=
mv -f -- "$temporary_path" "$dist_dir/asp-server.json"
temporary_path=

if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum < "$dist_dir/opcore" | awk '{print $1}')
else
  digest=$(shasum -a 256 < "$dist_dir/opcore" | awk '{print $1}')
fi
temporary_path=$(mktemp "$dist_dir/.opcore.sha256.XXXXXX")
printf '%s  %s\n' "$digest" opcore > "$temporary_path"
chmod 0644 "$temporary_path"
mv -f -- "$temporary_path" "$dist_dir/opcore.sha256"
temporary_path=
trap - EXIT HUP INT TERM
"$dist_dir/opcore" --version >/dev/null
verification_manifest=$(mktemp "${TMPDIR:-/tmp}/opcore-manifest.XXXXXX")
verification_native_manifest=$(mktemp \
  "${TMPDIR:-/tmp}/opcore-native-manifest.XXXXXX")
verification_node_manifest=$(mktemp \
  "${TMPDIR:-/tmp}/opcore-node-manifest.XXXXXX")
verification_python_manifest=$(mktemp \
  "${TMPDIR:-/tmp}/opcore-python-manifest.XXXXXX")
cleanup_verification() {
  rm -f -- \
    "$verification_manifest" \
    "$verification_native_manifest" \
    "$verification_node_manifest" \
    "$verification_python_manifest"
}
trap cleanup_verification EXIT HUP INT TERM
"$dist_dir/opcore" manifest \
  --profile fast \
  --executable "$dist_dir/opcore" > "$verification_manifest"
"$dist_dir/opcore" manifest \
  --profile rust-native \
  --executable "$dist_dir/opcore" > "$verification_native_manifest"
"$dist_dir/opcore" manifest \
  --profile node-native \
  --executable "$dist_dir/opcore" > "$verification_node_manifest"
"$dist_dir/opcore" manifest \
  --profile python-native \
  --executable "$dist_dir/opcore" > "$verification_python_manifest"
cmp "$verification_manifest" "$dist_dir/asp-server.json"
cmp "$verification_native_manifest" "$dist_dir/asp-server-rust-native.json"
cmp "$verification_node_manifest" "$dist_dir/asp-server-node-native.json"
cmp "$verification_python_manifest" "$dist_dir/asp-server-python-native.json"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dist_dir" && sha256sum -c opcore.sha256)
else
  test "$(shasum -a 256 < "$dist_dir/opcore" | awk '{print $1}')" = "$digest"
fi
rm -f -- \
  "$verification_manifest" \
  "$verification_native_manifest" \
  "$verification_node_manifest" \
  "$verification_python_manifest"
trap - EXIT HUP INT TERM
printf 'built %s\n' "$dist_dir/opcore"
printf 'manifest %s\n' "$dist_dir/asp-server.json"
printf 'manifest %s\n' "$dist_dir/asp-server-rust-native.json"
printf 'manifest %s\n' "$dist_dir/asp-server-node-native.json"
printf 'manifest %s\n' "$dist_dir/asp-server-python-native.json"
printf 'sha256:%s\n' "$digest"
