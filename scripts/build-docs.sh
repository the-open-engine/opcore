#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo_root"
command -v python3 >/dev/null || {
  printf 'build-docs: Python 3.9 or newer is required for local documentation\n' >&2
  exit 1
}
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "build-docs: Python 3.9 or newer is required")'
target_dir=$(cargo metadata --locked --no-deps --format-version 1 |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
site_dir=${OPCORE_DOCS_DIR:-"$repo_root/target/site"}

RUSTDOCFLAGS="${RUSTDOCFLAGS:-} -D warnings -D missing_docs" \
  cargo doc --locked --lib --no-deps
cargo build --locked --example cli-reference
python3 "$repo_root/scripts/build-docs.py" \
  "$target_dir/doc" "$target_dir/debug/examples/cli-reference" "$site_dir"
