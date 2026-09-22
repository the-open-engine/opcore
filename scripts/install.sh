#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
bundle_mode=false
if [[ -d "$script_dir/asp" || -d "$script_dir/bin" || \
      -f "$script_dir/opcore.sha256" ]]; then
  repo_root=$script_dir
  bundle_mode=true
elif [[ -f "$script_dir/../Cargo.toml" ]]; then
  repo_root=$(cd -- "$script_dir/.." && pwd -P)
else
  repo_root=$script_dir
fi
agent=auto
source_binary=
bin_dir=${OPCORE_BIN_DIR:-"${HOME:?HOME is required}/.local/bin"}
hooks=true
uninstall=false
force=false

usage() {
  printf '%s\n' \
    "Usage: install.sh [--agent codex|claude] [--bin-dir DIR] [--binary FILE] [--hooks|--no-hooks] [--force]" \
    "       install.sh --uninstall [--agent codex|claude] [--bin-dir DIR] [--binary FILE]" \
    "Uses a verified bundled binary when present, otherwise builds this checkout." \
    "The Verify and Project Sense post-write hook is installed by default."
}

require_value() {
  local remaining=$2
  local value=${3:-}
  if ((remaining < 2)) || [[ -z "$value" || "$value" == -* ]]; then
    printf 'install: %s requires a value\n' "$1" >&2
    usage >&2
    exit 64
  fi
}

while (($#)); do
  case "$1" in
    --agent)
      require_value "$1" "$#" "${2:-}"
      agent=$2
      shift 2
      ;;
    --bin-dir)
      require_value "$1" "$#" "${2:-}"
      bin_dir=$2
      shift 2
      ;;
    --binary)
      require_value "$1" "$#" "${2:-}"
      source_binary=$2
      shift 2
      ;;
    --hooks)
      hooks=true
      shift
      ;;
    --no-hooks)
      hooks=false
      shift
      ;;
    --uninstall)
      uninstall=true
      shift
      ;;
    --force)
      force=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'install: unsupported argument %s\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
  else
    shasum -a 256 < "$1" | awk '{print $1}'
  fi
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

requested_agent=$agent
shopt -s nullglob dotglob
owner_absent='opcore.owner.absent.v1'

# Canonicalize existing ancestors too, so new directories and paths with spaces
# retain the same identity after installation.
canonical_directory() {
  local path=$1 current=/ component
  local components=()
  if ((${#path} > 4096)) || [[ "$path" == *$'\n'* ]]; then
    printf 'install: ownership paths must fit on one bounded line\n' >&2
    return 1
  fi
  [[ "$path" == /* ]] || path="$(pwd -P)/$path"
  IFS=/ read -r -a components <<< "$path"
  for component in "${components[@]}"; do
    case "$component" in
      ''|.) continue ;;
      ..) current=$(dirname -- "$current") ;;
      *)
        current="${current%/}/$component"
        if [[ -d "$current" ]]; then
          current=$(cd -- "$current" && pwd -P) || return 1
        elif [[ -e "$current" || -L "$current" ]]; then
          printf 'install: destination ancestor is not a directory: %s\n' "$current" >&2
          return 1
        fi
        ;;
    esac
  done
  printf '%s\n' "$current"
}

bin_dir=$(canonical_directory "$bin_dir")
owners_base=$(canonical_directory "$HOME/.local/share/opcore/owners")
owners_dir="$owners_base/$(sha256_text "$bin_dir/opcore")"
if [[ -L "$owners_dir" || ( -e "$owners_dir" && ! -d "$owners_dir" ) ]]; then
  printf 'install: invalid shared ownership directory\n' >&2
  exit 1
fi

read_owner() {
  local file=$1 first extra
  owner_active=false
  owner_root=
  owner_skill=
  if [[ -L "$file" || ! -f "$file" || $(wc -c < "$file") -gt 16384 ]]; then
    printf 'install: invalid shared ownership record: %s\n' "$file" >&2
    exit 1
  fi
  if ! IFS= read -r first < "$file"; then
    printf 'install: invalid shared ownership record: %s\n' "$file" >&2
    exit 1
  fi
  if [[ "$first" == "$owner_absent" ]]; then
    if [[ $(sha256_file "$file") != $(printf '%s\n' "$owner_absent" | sha256_file /dev/stdin) ]]; then
      printf 'install: ambiguous inactive ownership record\n' >&2
      exit 1
    fi
    return 0
  fi
  {
    owner_root=$first
    if ! IFS= read -r owner_skill; then
      printf 'install: incomplete shared ownership record\n' >&2
      exit 1
    fi
    if IFS= read -r extra || [[ -n "$extra" ]]; then
      printf 'install: ambiguous shared ownership record\n' >&2
      exit 1
    fi
  } < <(sed -n '2,$p' "$file")
  if [[ "$owner_root" != /* || "$owner_skill" != /* ||
        $(sha256_file "$file") != $(printf '%s\n%s\n' "$owner_root" "$owner_skill" | sha256_file /dev/stdin) ]]; then
    printf 'install: invalid shared ownership paths\n' >&2
    exit 1
  fi
  owner_active=true
}

selected_agents=()
case "$agent" in
  auto)
    if [[ "$uninstall" == true && -d "$owners_dir" ]]; then
      for candidate in codex claude; do
        read_owner "$owners_dir/$candidate"
        if [[ "$owner_active" == true ]]; then selected_agents+=("$candidate"); fi
      done

    else
      if [[ "$uninstall" == true ]]; then
        for candidate in codex claude; do
          candidate_root=${CODEX_HOME:-"$HOME/.codex"}
          if [[ "$candidate" == claude ]]; then candidate_root=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}; fi
          if [[ -e "$candidate_root/opcore/install.receipt" ||
                -L "$candidate_root/opcore/install.receipt" ]]; then
            selected_agents+=("$candidate")
          fi
        done
      else
        if [[ -n ${CODEX_HOME:-} || -d "$HOME/.codex" ]]; then selected_agents+=(codex); fi
        if [[ -n ${CLAUDE_CONFIG_DIR:-} || -d "$HOME/.claude" ]]; then selected_agents+=(claude); fi
      fi
    fi
    if ((${#selected_agents[@]} == 0)); then
      printf 'install: no supported agent detected; pass --agent codex or --agent claude\n' >&2
      exit 64
    fi
    ;;
  codex|claude) selected_agents=("$agent") ;;
  *) printf 'install: unsupported agent %s; expected codex or claude\n' "$agent" >&2; exit 64 ;;
esac

prepare_binary() {
if [[ -z "$source_binary" ]]; then
  if [[ "$bundle_mode" == true ]]; then
    [[ -f "$repo_root/bin/opcore" ]] || {
      printf 'install: bundled binary is missing: %s\n' "$repo_root/bin/opcore" >&2
      exit 1
    }
    [[ -f "$repo_root/opcore.sha256" ]] || {
      printf 'install: bundled checksum is missing: %s\n' "$repo_root/opcore.sha256" >&2
      exit 1
    }
    read -r bundled_digest bundled_name bundled_extra < "$repo_root/opcore.sha256"
    if [[ ! "$bundled_digest" =~ ^[0-9a-f]{64}$ ]] || \
       [[ "$bundled_name" != "bin/opcore" || -n ${bundled_extra:-} ]]; then
      printf 'install: bundled checksum file is malformed\n' >&2
      exit 1
    fi
    if [[ $(sha256_file "$repo_root/bin/opcore") != "$bundled_digest" ]]; then
      printf 'install: bundled binary checksum does not match\n' >&2
      exit 1
    fi
    source_binary="$repo_root/bin/opcore"
  else
    command -v cargo >/dev/null || { printf 'install: cargo is required to build opcore\n' >&2; exit 1; }
    (cd "$repo_root" && cargo build --locked --release)
    target_dir=${CARGO_TARGET_DIR:-target}
    if [[ "$target_dir" = /* ]]; then
      source_binary="$target_dir/release/opcore"
    else
      source_binary="$repo_root/$target_dir/release/opcore"
    fi
  fi
fi

[[ -f "$source_binary" ]] || { printf 'install: binary not found: %s\n' "$source_binary" >&2; exit 1; }
[[ -f "$repo_root/skills/opcore/SKILL.md" ]] || {
  printf 'install: bundled agent skill is missing\n' >&2
  exit 1
}
if [[ " ${selected_agents[*]} " == *" codex "* && ! -f "$repo_root/skills/opcore/agents/openai.yaml" ]]; then
  printf 'install: bundled Codex skill descriptor is missing\n' >&2
  exit 1
fi
source_dir=$(cd -- "$(dirname -- "$source_binary")" && pwd -P)
source_binary="$source_dir/$(basename -- "$source_binary")"

shared_preflight_dir=$(mktemp -d "${TMPDIR:-/tmp}/opcore-preflight.XXXXXX")
shared_prepared_binary="$shared_preflight_dir/opcore"
install -m 0755 "$source_binary" "$shared_prepared_binary"
"$shared_prepared_binary" --version >/dev/null
"$shared_prepared_binary" manifest \
  --profile fast \
  --executable "$shared_prepared_binary" > "$shared_preflight_dir/asp-server.json"
"$shared_prepared_binary" manifest \
  --profile rust-native \
  --executable "$shared_prepared_binary" > "$shared_preflight_dir/asp-server-rust-native.json"
"$shared_prepared_binary" manifest \
  --profile node-native \
  --executable "$shared_prepared_binary" > "$shared_preflight_dir/asp-server-node-native.json"
"$shared_prepared_binary" manifest \
  --profile python-native \
  --executable "$shared_prepared_binary" > "$shared_preflight_dir/asp-server-python-native.json"

}

select_context() {
  local agent=$1
case "$agent" in
  codex)
    agent_root=${CODEX_HOME:-"$HOME/.codex"}
    skill_root=${OPCORE_SKILL_DIR:-"$HOME/.agents/skills"}
    ;;
  claude)
    agent_root=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
    skill_root="$agent_root/skills"
    ;;
  *)
    printf 'install: unsupported agent %s; expected codex or claude\n' "$agent" >&2
    exit 64
    ;;
esac

if [[ "$uninstall" == true && "$requested_agent" == auto && -f "$owners_dir/$agent" ]]; then
  read_owner "$owners_dir/$agent"
  agent_root=$owner_root
  skill_root=$owner_skill
fi
agent_root=$(canonical_directory "$agent_root")
skill_root=$(canonical_directory "$skill_root")
for owner_path in "$agent_root" "$skill_root" "$bin_dir"; do
  if [[ "$owner_path" == *$'\n'* ]]; then
    printf 'install: newline in ownership path is unsupported\n' >&2
    exit 1
  fi
done
}

run_agent() (
agent=$1
validate_only=$2
select_context "$agent"

installed_binary="$bin_dir/opcore"
skill_path="$skill_root/opcore/SKILL.md"
agent_descriptor_path="$skill_root/opcore/agents/openai.yaml"
manifest_path="$agent_root/opcore/asp-server.json"
native_manifest_path="$agent_root/opcore/asp-server-rust-native.json"
node_manifest_path="$agent_root/opcore/asp-server-node-native.json"
python_manifest_path="$agent_root/opcore/asp-server-python-native.json"
hook_receipt_path="$agent_root/opcore/hook-install.json"
install_receipt_path="$agent_root/opcore/install.receipt"
installed_installer_path="$agent_root/opcore/uninstall.sh"
case "$agent" in
  codex) hook_config_path="$agent_root/hooks.json" ;;
  claude) hook_config_path="$agent_root/settings.json" ;;
esac

require_managed_directory() {
  local path=$1 label=$2
  if [[ -L "$path" ]]; then
    printf 'install: refusing symlinked managed %s directory: %s\n' "$label" "$path" >&2
    exit 1
  fi
  if [[ -e "$path" && ! -d "$path" ]]; then
    printf 'install: managed %s path is not a directory: %s\n' "$label" "$path" >&2
    exit 1
  fi
}

require_managed_directory "$agent_root/opcore" runtime
require_managed_directory "$skill_root/opcore" skill
if [[ "$agent" == codex ]]; then
  require_managed_directory "$skill_root/opcore/agents" skill-descriptor
fi
if [[ -L "$install_receipt_path" || \
      ( -e "$install_receipt_path" && ! -f "$install_receipt_path" ) ]]; then
  printf 'install: install receipt path is not a regular file: %s\n' \
    "$install_receipt_path" >&2
  exit 1
fi
if [[ -L "$hook_receipt_path" || \
      ( -e "$hook_receipt_path" && ! -f "$hook_receipt_path" ) ]]; then
  printf 'install: hook ownership receipt path is not a regular file: %s\n' \
    "$hook_receipt_path" >&2
  exit 1
fi

temporary_path=
native_manifest_temporary_path=
node_manifest_temporary_path=
python_manifest_temporary_path=
preflight_dir=
# Invoked by the EXIT trap inside the per-agent subshell.
# shellcheck disable=SC2329
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
  if [[ -n "$preflight_dir" ]]; then
    rm -rf -- "$preflight_dir"
  fi
}

# shellcheck disable=SC2329
handle_signal() {
  local status=$1
  trap - HUP INT TERM
  exit "$status"
}
trap cleanup_temporary EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM


receipt_digest() {
  local wanted=$1 key value extra
  while read -r key value extra; do
    if [[ "$key" == "$wanted" && -z ${extra:-} && "$value" =~ ^[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < "$install_receipt_path"
  return 1
}

receipt_value() {
  local wanted=$1 key value extra
  while read -r key value extra; do
    if [[ "$key" == "$wanted" && -n "$value" && -z ${extra:-} ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < "$install_receipt_path"
  return 1
}

receipt_version() {
  local receipt_agent receipt_schema
  if [[ $(wc -c < "$install_receipt_path") -gt 16384 ]]; then
    printf 'install: oversized install receipt\n' >&2
    return 1
  fi
  if ! awk 'NR > 1 { if (NF != 2 || seen[$1]++) exit 1 }' "$install_receipt_path"; then
    printf 'install: ambiguous install receipt entries\n' >&2
    return 1
  fi
  read -r receipt_schema < "$install_receipt_path"
  case "$receipt_schema" in
    opcore.install.v1) printf '%s\n' 1 ;;
    opcore.install.v2) printf '%s\n' 2 ;;
    opcore.install.v3) printf '%s\n' 3 ;;
    opcore.install.v4) printf '%s\n' 4 ;;
    opcore.install.v5)
      if receipt_digest owners_path >/dev/null || receipt_value agent >/dev/null; then
        printf 'install: version 5 receipt contains shared-ownership fields\n' >&2
        return 1
      fi
      printf '%s\n' 5
      ;;
    opcore.install.v6)
      receipt_digest owners_path >/dev/null || {
        printf 'install: version 6 receipt is missing shared ownership\n' >&2
        return 1
      }
      receipt_agent=$(receipt_value agent) || {
        printf 'install: version 6 receipt is missing its agent identity\n' >&2
        return 1
      }
      case "$receipt_agent" in codex|claude) ;; *)
        printf 'install: version 6 receipt has an invalid agent identity\n' >&2
        return 1
      esac
      printf '%s\n' 6
      ;;
    *)
      printf 'install: unsupported install receipt\n' >&2
      return 1
      ;;
  esac
}

require_receipt_path() {
  local key=$1 path=$2 label=$3 expected
  expected=$(receipt_digest "$key") || {
    printf 'install: receipt is missing the %s path identity\n' "$label" >&2
    exit 1
  }
  if [[ $(sha256_text "$path") != "$expected" ]]; then
    printf 'install: %s changed since the prior install; uninstall it from its recorded location first\n' \
      "$label" >&2
    exit 1
  fi
}

remove_if_owned() {
  local path=$1 expected=$2 label=$3
  [[ -e "$path" || -L "$path" ]] || return 0
  if [[ ! -L "$path" && -f "$path" && $(sha256_file "$path") == "$expected" ]]; then
    rm -f -- "$path"
    return 0
  fi
  printf 'uninstall: retained modified %s: %s\n' "$label" "$path" >&2
  return 1
}

atomic_install() {
  local source=$1
  local mode=$2
  local destination=$3
  local destination_dir destination_name
  destination_dir=$(dirname -- "$destination")
  destination_name=$(basename -- "$destination")
  temporary_path=$(mktemp "$destination_dir/.${destination_name}.XXXXXX")
  install -m "$mode" "$source" "$temporary_path"
  mv -f -- "$temporary_path" "$destination"
  temporary_path=
}

require_owned_or_absent() {
  local path=$1 key=$2 label=$3 expected=
  [[ ! -e "$path" && ! -L "$path" ]] && return 0
  if [[ -L "$path" ]]; then
    printf 'install: refusing to replace symlinked %s: %s\n' "$label" "$path" >&2
    exit 1
  fi
  if [[ ! -f "$path" ]]; then
    printf 'install: refusing to replace non-file %s: %s\n' "$label" "$path" >&2
    exit 1
  fi
  [[ "$force" == true ]] && return 0
  if [[ -f "$install_receipt_path" ]]; then
    expected=$(receipt_digest "$key" || true)
    if [[ -n "$expected" && -f "$path" && $(sha256_file "$path") == "$expected" ]]; then
      return 0
    fi
  fi
  printf 'install: refusing to replace unowned %s: %s; pass --force to replace it\n' \
    "$label" "$path" >&2
  exit 1
}

if [[ -f "$install_receipt_path" ]]; then
  current_receipt_version=$(receipt_version) || exit 1
fi
if [[ -f "$install_receipt_path" ]] && ((current_receipt_version >= 5)); then
  require_receipt_path binary_path "$installed_binary" binary-destination
  if ((current_receipt_version >= 6)) && [[ $(receipt_value agent) != "$agent" ]]; then
    printf 'install: receipt agent identity does not match its destination\n' >&2
    exit 1
  fi
fi
if [[ -f "$install_receipt_path" ]] && receipt_digest owners_path >/dev/null; then
  require_receipt_path owners_path "$owners_dir" shared-ownership-directory
  if [[ "$uninstall" == true && ! -f "$owners_dir/$agent" ]]; then
    printf 'uninstall: shared owner record is missing; restore it or reinstall before removal\n' >&2
    exit 1
  fi
fi

# Every owner must still have a receipt at its bound location. Never silently
# drop a stale owner, since that could delete another agent's executable.
shared_binary_owned=false
other_owners=0
other_binary_digest=
registry_binary_digest=
if [[ -d "$owners_dir" ]]; then
  for owner_agent in codex claude; do
    if [[ ! -f "$owners_dir/$owner_agent" || -L "$owners_dir/$owner_agent" ]]; then
      printf 'install: shared ownership slot is missing or unsafe: %s\n' "$owner_agent" >&2
      exit 1
    fi
  done
  for owner_file in "$owners_dir"/*; do
    [[ -e "$owner_file" || -L "$owner_file" ]] || continue
    owner_agent=$(basename -- "$owner_file")
    case "$owner_agent" in codex|claude) ;; *) printf 'install: ambiguous shared ownership entry\n' >&2; exit 1 ;; esac
    read_owner "$owner_file"
    if [[ "$owner_active" != true ]]; then continue; fi
    if [[ $(canonical_directory "$owner_root") != "$owner_root" ||
          $(canonical_directory "$owner_skill") != "$owner_skill" ]]; then
      printf 'install: shared ownership paths changed\n' >&2
      exit 1
    fi
    owner_receipt="$owner_root/opcore/install.receipt"
    if [[ -L "$owner_root/opcore" || -L "$owner_receipt" || ! -f "$owner_receipt" ]]; then
      printf 'install: shared owner receipt is missing or unsafe: %s\n' "$owner_receipt" >&2
      exit 1
    fi
    saved_receipt=$install_receipt_path
    install_receipt_path=$owner_receipt
    owner_version=$(receipt_version)
    if ((owner_version < 5)); then printf 'install: invalid shared owner receipt version\n' >&2; exit 1; fi
    if ((owner_version < 6)) || [[ $(receipt_value agent) != "$owner_agent" ]]; then
      printf 'install: shared owner receipt has no matching agent identity\n' >&2
      exit 1
    fi
    require_receipt_path agent_root_path "$owner_root" shared-agent-root
    require_receipt_path binary_path "$installed_binary" shared-binary
    require_receipt_path owners_path "$owners_dir" shared-ownership-directory
    require_receipt_path skill_path "$owner_skill/opcore/SKILL.md" shared-skill
    owner_digest=$(receipt_digest binary)
    if [[ "$uninstall" == true && -n "$registry_binary_digest" && "$registry_binary_digest" != "$owner_digest" ]]; then
      printf 'uninstall: shared owner binary receipts disagree; rerun the default installation\n' >&2
      exit 1
    fi
    registry_binary_digest=$owner_digest
    install_receipt_path=$saved_receipt
    if [[ ! -L "$installed_binary" && -f "$installed_binary" && \
         $(sha256_file "$installed_binary") == "$owner_digest" ]]; then
      shared_binary_owned=true
    fi
    if [[ "$owner_agent" == "$agent" ]]; then
      if [[ "$owner_root" != "$agent_root" || "$owner_skill" != "$skill_root" ]]; then
        printf 'install: agent already owns this binary from another location; uninstall that integration first\n' >&2
        exit 1
      fi
    else
      if [[ "$owner_root" == "$agent_root" || "$owner_skill" == "$skill_root" ]]; then
        printf 'install: agents must have distinct runtime and skill destinations\n' >&2
        exit 1
      fi
      other_owners=$((other_owners + 1))
      other_binary_digest=$owner_digest
    fi
  done
fi

validate_uninstall_artifacts() {
  validate_owned_artifact skill "$skill_path"
  validate_owned_artifact manifest "$manifest_path"
  if ((receipt_manifest_version >= 2)); then
    validate_owned_artifact native_manifest "$native_manifest_path"
  fi
  if ((receipt_manifest_version >= 3)); then
    validate_owned_artifact node_native_manifest "$node_manifest_path"
    validate_owned_artifact python_native_manifest "$python_manifest_path"
  fi
  if [[ "$agent" == codex ]]; then validate_owned_artifact descriptor "$agent_descriptor_path"; fi
  if ((receipt_manifest_version >= 4)); then validate_owned_artifact installer "$installed_installer_path"; fi
}

validate_owned_artifact() {
  local expected
  expected=$(receipt_digest "$1") || exit 1
  if [[ -e "$2" || -L "$2" ]]; then
    if [[ -L "$2" || ! -f "$2" || $(sha256_file "$2") != "$expected" ]]; then
      printf 'uninstall: retained modified %s: %s\n' "$1" "$2" >&2
      exit 1
    fi
  fi
}

if [[ "$uninstall" == true ]]; then
  receipt_manifest_version=0
  if [[ -f "$install_receipt_path" ]]; then
    receipt_manifest_version=$(receipt_version) || exit 1
    if ((receipt_manifest_version <= 3)) && [[ "$agent" == codex ]]; then
      require_managed_directory "$agent_root/skills/opcore" legacy-skill
      require_managed_directory \
        "$agent_root/skills/opcore/agents" \
        legacy-skill-descriptor
      skill_path="$agent_root/skills/opcore/SKILL.md"
      agent_descriptor_path="$agent_root/skills/opcore/agents/openai.yaml"
    elif ((receipt_manifest_version >= 5)); then
      require_receipt_path agent_root_path "$agent_root" agent-root
      require_receipt_path binary_path "$installed_binary" binary-destination
      require_receipt_path skill_path "$skill_path" skill-destination
      if ((receipt_manifest_version >= 6)) && [[ $(receipt_value agent) != "$agent" ]]; then
        printf 'uninstall: receipt agent identity does not match its destination\n' >&2
        exit 1
      fi
      receipt_hooks=$(receipt_value hooks) || {
        printf 'uninstall: receipt is missing its hook enrollment state\n' >&2
        exit 1
      }
      case "$receipt_hooks" in
        yes)
          if [[ ! -f "$hook_receipt_path" ]]; then
            printf '%s\n' \
              'uninstall: the install receipt records a hook, but its ownership receipt is missing' \
              'uninstall: restore the hook receipt or reinstall with --hooks before uninstalling' >&2
            exit 1
          fi
          ;;
        pending)
          ;;
        no)
          if [[ -e "$hook_receipt_path" || -L "$hook_receipt_path" ]]; then
            printf 'uninstall: found an unexpected hook receipt; refusing to guess ownership\n' >&2
            exit 1
          fi
          ;;
        *)
          printf 'uninstall: invalid hook enrollment state in install receipt\n' >&2
          exit 1
          ;;
      esac
    fi
  fi
  if [[ ! -f "$install_receipt_path" ]]; then
    printf 'uninstall: install receipt is missing; refusing to guess ownership or execute installed files\n' >&2
    exit 1
  fi
  validate_uninstall_artifacts
  if [[ "$validate_only" == true ]]; then exit 0; fi
  if [[ -f "$hook_receipt_path" ]]; then
    control_binary=
    if [[ -f "$install_receipt_path" && -x "$installed_binary" ]]; then
      expected_binary_digest=$(receipt_digest binary) || exit 1
      if [[ $(sha256_file "$installed_binary") == "$expected_binary_digest" ]]; then
        control_binary=$installed_binary
      fi
    fi
    if [[ -z "$control_binary" && -n "$source_binary" && -f "$source_binary" ]]; then
      control_binary=$source_binary
    fi
    if [[ -z "$control_binary" && -f "$repo_root/Cargo.toml" ]]; then
      command -v cargo >/dev/null || {
        printf 'uninstall: a trusted --binary is required to remove the installed hook safely\n' >&2
        exit 1
      }
        (cd "$repo_root" && cargo build --locked --release)
        target_dir=${CARGO_TARGET_DIR:-target}
        case "$target_dir" in
          /*) control_binary="$target_dir/release/opcore" ;;
          *) control_binary="$repo_root/$target_dir/release/opcore" ;;
        esac
    fi
    if [[ -z "$control_binary" ]]; then
      printf '%s\n' \
        'uninstall: refusing to execute a missing or modified installed binary while removing the hook' \
        'uninstall: rerun with --binary pointing to a trusted Opcore binary' >&2
      exit 1
    fi
    control_version=$("$control_binary" --version 2>/dev/null) || {
      printf 'uninstall: trusted control binary did not report its version\n' >&2
      exit 1
    }
    if [[ "$control_version" != "opcore "* || "$control_version" == *$'\n'* ]]; then
      printf 'uninstall: trusted control binary did not identify itself as opcore\n' >&2
      exit 1
    fi
    "$control_binary" configure-hook \
      --agent "$agent" \
      --config "$hook_config_path" \
      --binary "$installed_binary" \
      --receipt "$hook_receipt_path" \
      --remove
    if [[ -e "$hook_receipt_path" || -L "$hook_receipt_path" ]]; then
      printf 'uninstall: hook removal did not clear its ownership receipt\n' >&2
      exit 1
    fi
    printf 'removed %s hook\n' "$agent"
  fi
  retained=false
  if [[ -f "$install_receipt_path" ]]; then
    skill_digest=$(receipt_digest skill) || exit 1
    manifest_digest=$(receipt_digest manifest) || exit 1
    binary_digest=$(receipt_digest binary) || exit 1
    remove_if_owned "$skill_path" "$skill_digest" skill || retained=true
    if [[ "$agent" == codex ]]; then
      descriptor_digest=$(receipt_digest descriptor) || exit 1
      remove_if_owned "$agent_descriptor_path" "$descriptor_digest" descriptor || retained=true
    fi
    if ((receipt_manifest_version >= 2)); then
      native_manifest_digest=$(receipt_digest native_manifest) || exit 1
      remove_if_owned \
        "$native_manifest_path" \
        "$native_manifest_digest" \
        rust-native-manifest || retained=true
    fi
    if ((receipt_manifest_version >= 3)); then
      node_manifest_digest=$(receipt_digest node_native_manifest) || exit 1
      python_manifest_digest=$(receipt_digest python_native_manifest) || exit 1
      remove_if_owned \
        "$node_manifest_path" \
        "$node_manifest_digest" \
        node-native-manifest || retained=true
      remove_if_owned \
        "$python_manifest_path" \
        "$python_manifest_digest" \
        python-native-manifest || retained=true
    fi
    remove_if_owned "$manifest_path" "$manifest_digest" manifest || retained=true
    if ((other_owners == 0)); then
      remove_if_owned "$installed_binary" "$binary_digest" binary || retained=true
    fi
    if ((receipt_manifest_version >= 4)) && [[ "$retained" == false ]]; then
      installer_digest=$(receipt_digest installer) || exit 1
      remove_if_owned "$installed_installer_path" "$installer_digest" installer || retained=true
    fi
    if [[ "$retained" == false ]]; then
      rm -f -- "$install_receipt_path"
      if ((receipt_manifest_version >= 6)); then
        temporary_path=$(mktemp "$owners_dir/.owner.XXXXXX")
        printf '%s\n' "$owner_absent" > "$temporary_path"
        chmod 0600 "$temporary_path"
        mv -f -- "$temporary_path" "$owners_dir/$agent"
        temporary_path=
        if ((other_owners == 0)); then
          for owner_agent in codex claude; do
            read_owner "$owners_dir/$owner_agent"
            if [[ "$owner_active" == true ]]; then
              printf 'uninstall: active owner remains after final cleanup\n' >&2
              exit 1
            fi
          done
        fi
      fi
    fi
  else
    printf '%s\n' \
      'uninstall: install receipt is missing; refusing to guess ownership or execute installed files' >&2
    exit 1
  fi
  rmdir -- "$(dirname -- "$agent_descriptor_path")" 2>/dev/null || true
  rmdir -- "$(dirname -- "$skill_path")" 2>/dev/null || true
  rmdir -- "$agent_root/opcore" 2>/dev/null || true
  if [[ "$retained" == true ]]; then
    printf 'uninstall incomplete: modified files were retained; see messages above\n' >&2
    exit 1
  fi
  printf 'uninstalled owned Opcore files\n'
  exit 0
fi

preflight_dir=$(mktemp -d "${TMPDIR:-/tmp}/opcore-agent.XXXXXX")
prepared_binary=$shared_prepared_binary

printf -v bound_binary '%q' "$installed_binary"
skill_replacement=${bound_binary//\\/\\\\}
skill_replacement=${skill_replacement//&/\\&}
skill_replacement=${skill_replacement//|/\\|}
prepared_skill="$preflight_dir/SKILL.md"
sed "s|opcore |${skill_replacement} |g" \
  "$repo_root/skills/opcore/SKILL.md" > "$prepared_skill"
chmod 0644 "$prepared_skill"

migrate_legacy_skill=false
migrate_legacy_descriptor=false
hook_enrolled=$hooks
legacy_skill_path="$agent_root/skills/opcore/SKILL.md"
legacy_descriptor_path="$agent_root/skills/opcore/agents/openai.yaml"
prior_receipt_version=0
if [[ -f "$install_receipt_path" ]]; then
  prior_receipt_version=$(receipt_version) || exit 1
  if ((prior_receipt_version >= 5)); then
    require_receipt_path agent_root_path "$agent_root" agent-root
    require_receipt_path binary_path "$installed_binary" binary-destination
    require_receipt_path skill_path "$skill_path" skill-destination
    if ((prior_receipt_version >= 6)) && [[ $(receipt_value agent) != "$agent" ]]; then
      printf 'install: receipt agent identity does not match its destination\n' >&2
      exit 1
    fi
    prior_hooks=$(receipt_value hooks) || {
      printf 'install: receipt is missing its hook enrollment state\n' >&2
      exit 1
    }
    case "$prior_hooks" in
      yes)
        if [[ ! -f "$hook_receipt_path" ]]; then
          if [[ "$hooks" == true ]]; then
            hook_enrolled=false
          else
            printf '%s\n' \
              'install: the prior install records a hook, but its ownership receipt is missing' \
              'install: restore it or rerun with --hooks to repair the hook transaction' >&2
            exit 1
          fi
        else
          hook_enrolled=true
        fi
        ;;
      pending)
        if [[ -f "$hook_receipt_path" ]]; then
          hook_enrolled=true
        else
          hook_enrolled=false
        fi
        ;;
      no)
        if [[ -e "$hook_receipt_path" || -L "$hook_receipt_path" ]]; then
          printf 'install: found an unexpected hook receipt; refusing to adopt it\n' >&2
          exit 1
        fi
        ;;
      *)
        printf 'install: invalid hook enrollment state in install receipt\n' >&2
        exit 1
        ;;
    esac
  elif ((prior_receipt_version <= 3)) && [[ "$agent" == codex ]]; then
    require_managed_directory "$agent_root/skills/opcore" legacy-skill
    require_managed_directory \
      "$agent_root/skills/opcore/agents" \
      legacy-skill-descriptor
    if [[ "$legacy_skill_path" != "$skill_path" && \
          ( -e "$legacy_skill_path" || -L "$legacy_skill_path" ) ]]; then
      legacy_skill_digest=$(receipt_digest skill) || exit 1
      if [[ -f "$legacy_skill_path" && \
            $(sha256_file "$legacy_skill_path") == "$legacy_skill_digest" ]]; then
        migrate_legacy_skill=true
      elif [[ "$force" != true ]]; then
        printf 'install: refusing to leave a modified legacy skill at %s\n' \
          "$legacy_skill_path" >&2
        exit 1
      fi
    fi
    if [[ "$legacy_descriptor_path" != "$agent_descriptor_path" && \
          ( -e "$legacy_descriptor_path" || -L "$legacy_descriptor_path" ) ]]; then
      legacy_descriptor_digest=$(receipt_digest descriptor) || exit 1
      if [[ -f "$legacy_descriptor_path" && \
            $(sha256_file "$legacy_descriptor_path") == "$legacy_descriptor_digest" ]]; then
        migrate_legacy_descriptor=true
      elif [[ "$force" != true ]]; then
        printf 'install: refusing to leave a modified legacy descriptor at %s\n' \
          "$legacy_descriptor_path" >&2
        exit 1
      fi
    fi
  fi
  if ((prior_receipt_version < 5)) && [[ -f "$hook_receipt_path" ]]; then
    hook_enrolled=true
  fi
elif [[ -e "$hook_receipt_path" || -L "$hook_receipt_path" ]]; then
  printf 'install: refusing to adopt an unowned hook receipt: %s\n' \
    "$hook_receipt_path" >&2
  exit 1
fi

# A historical single-agent install has no shared registry yet. Validate a
# selected peer's v5 receipt before accepting its existing executable; the
# all-agent preflight still checks that peer's complete integration.
# Peer receipt projection intentionally stays inside its subshell.
# shellcheck disable=SC2030
selected_peer_owns_binary() (
  local peer=$1 install_receipt_path
  select_context "$peer"
  install_receipt_path="$agent_root/opcore/install.receipt"
  [[ ! -L "$agent_root/opcore" && ! -L "$install_receipt_path" &&
     -f "$install_receipt_path" && ! -L "$installed_binary" && -f "$installed_binary" ]] || return 1
  [[ $(receipt_version) == 5 ]] || return 1
  require_receipt_path agent_root_path "$agent_root" peer-agent-root
  require_receipt_path binary_path "$installed_binary" peer-binary
  require_receipt_path skill_path "$skill_root/opcore/SKILL.md" peer-skill
  [[ $(receipt_digest binary) == "$(sha256_file "$installed_binary")" ]]
)
if [[ "$shared_binary_owned" != true && "$requested_agent" == auto ]]; then
  for peer in "${selected_agents[@]}"; do
    if [[ "$peer" != "$agent" ]] && selected_peer_owns_binary "$peer"; then
      shared_binary_owned=true
    fi
  done
fi

if [[ "$shared_binary_owned" != true ]]; then
  require_owned_or_absent "$installed_binary" binary binary
fi
if ((other_owners > 0)) && [[ "$other_binary_digest" != $(sha256_file "$prepared_binary") ]]; then
  if [[ "$requested_agent" != auto ]]; then
    printf 'install: shared binary update requires the default install for all owners\n' >&2
    exit 1
  fi
  for owner_file in "$owners_dir"/*; do
    owner_agent=$(basename -- "$owner_file")
    if [[ " ${selected_agents[*]} " != *" $owner_agent "* ]]; then
      printf 'install: shared binary update requires detecting every existing owner\n' >&2
      exit 1
    fi
  done
fi
require_owned_or_absent "$skill_path" skill skill
require_owned_or_absent "$manifest_path" manifest manifest
require_owned_or_absent "$native_manifest_path" native_manifest rust-native-manifest
require_owned_or_absent "$node_manifest_path" node_native_manifest node-native-manifest
require_owned_or_absent "$python_manifest_path" python_native_manifest python-native-manifest
require_owned_or_absent "$installed_installer_path" installer uninstaller
if [[ "$agent" == codex ]]; then
  require_owned_or_absent "$agent_descriptor_path" descriptor descriptor
fi

if [[ "$validate_only" == true ]]; then
  if [[ "$hooks" == true ]]; then
    "$prepared_binary" configure-hook \
      --agent "$agent" \
      --config "$hook_config_path" \
      --binary "$installed_binary" \
      --receipt "$hook_receipt_path" \
      --check
  fi
  exit 0
fi
install -d "$bin_dir" "$skill_root/opcore" "$agent_root/opcore"
if [[ ! -f "$installed_binary" || $(sha256_file "$installed_binary") != $(sha256_file "$prepared_binary") ]]; then
  atomic_install "$prepared_binary" 0755 "$installed_binary"
fi
atomic_install "$prepared_skill" 0644 "$skill_path"
if [[ "$agent" == codex ]]; then
  install -d "$skill_root/opcore/agents"
  atomic_install \
    "$repo_root/skills/opcore/agents/openai.yaml" \
    0644 \
    "$agent_descriptor_path"
fi
prepared_installer="$preflight_dir/uninstall.sh"
{
  sed -n '1p' "${BASH_SOURCE[0]}"
  printf 'export HOME=%q\n' "$HOME"
  if [[ "$agent" == codex ]]; then
    printf '%s\n' 'unset CLAUDE_CONFIG_DIR'
    printf 'export CODEX_HOME=%q\n' "$agent_root"
    printf 'export OPCORE_SKILL_DIR=%q\n' "$skill_root"
  else
    printf '%s\n' 'unset CODEX_HOME OPCORE_SKILL_DIR'
    printf 'export CLAUDE_CONFIG_DIR=%q\n' "$agent_root"
  fi
  printf 'export OPCORE_BIN_DIR=%q\n' "$bin_dir"
  sed -n '2,$p' "${BASH_SOURCE[0]}"
} > "$prepared_installer"
chmod 0755 "$prepared_installer"
atomic_install "$prepared_installer" 0755 "$installed_installer_path"

temporary_path=$(mktemp "$agent_root/opcore/.asp-server.json.XXXXXX")
native_manifest_temporary_path=$(mktemp \
  "$agent_root/opcore/.asp-server-rust-native.json.XXXXXX")
node_manifest_temporary_path=$(mktemp \
  "$agent_root/opcore/.asp-server-node-native.json.XXXXXX")
python_manifest_temporary_path=$(mktemp \
  "$agent_root/opcore/.asp-server-python-native.json.XXXXXX")
"$installed_binary" manifest \
  --profile fast \
  --executable "$installed_binary" > "$temporary_path"
"$installed_binary" manifest \
  --profile rust-native \
  --executable "$installed_binary" > "$native_manifest_temporary_path"
"$installed_binary" manifest \
  --profile node-native \
  --executable "$installed_binary" > "$node_manifest_temporary_path"
"$installed_binary" manifest \
  --profile python-native \
  --executable "$installed_binary" > "$python_manifest_temporary_path"
chmod 0644 \
  "$temporary_path" \
  "$native_manifest_temporary_path" \
  "$node_manifest_temporary_path" \
  "$python_manifest_temporary_path"
mv -f -- "$python_manifest_temporary_path" "$python_manifest_path"
python_manifest_temporary_path=
mv -f -- "$node_manifest_temporary_path" "$node_manifest_path"
node_manifest_temporary_path=
mv -f -- "$native_manifest_temporary_path" "$native_manifest_path"
native_manifest_temporary_path=
mv -f -- "$temporary_path" "$manifest_path"
temporary_path=
"$installed_binary" --version >/dev/null
binary_digest=$(sha256_file "$installed_binary")
skill_digest=$(sha256_file "$skill_path")
manifest_digest=$(sha256_file "$manifest_path")
native_manifest_digest=$(sha256_file "$native_manifest_path")
node_manifest_digest=$(sha256_file "$node_manifest_path")
python_manifest_digest=$(sha256_file "$python_manifest_path")
# Uses this agent's receipt, not the isolated peer projection above.
# shellcheck disable=SC2031
publish_install_receipt() {
  local hook_state=$1
  temporary_path=$(mktemp "$agent_root/opcore/.install.receipt.XXXXXX")
  {
    printf '%s\n' opcore.install.v6
    printf 'agent %s\n' "$agent"
    printf 'binary %s\n' "$binary_digest"
    printf 'skill %s\n' "$skill_digest"
    printf 'manifest %s\n' "$manifest_digest"
    printf 'native_manifest %s\n' "$native_manifest_digest"
    printf 'node_native_manifest %s\n' "$node_manifest_digest"
    printf 'python_native_manifest %s\n' "$python_manifest_digest"
    printf 'installer %s\n' "$(sha256_file "$installed_installer_path")"
    printf 'agent_root_path %s\n' "$(sha256_text "$agent_root")"
    printf 'binary_path %s\n' "$(sha256_text "$installed_binary")"
    printf 'owners_path %s\n' "$(sha256_text "$owners_dir")"
    printf 'skill_path %s\n' "$(sha256_text "$skill_path")"
    printf 'hooks %s\n' "$hook_state"
    if [[ "$agent" == codex ]]; then
      printf 'descriptor %s\n' "$(sha256_file "$agent_descriptor_path")"
    fi
  } > "$temporary_path"
  chmod 0600 "$temporary_path"
  mv -f -- "$temporary_path" "$install_receipt_path"
  temporary_path=
  if [[ ! -f "$install_receipt_path" || -L "$install_receipt_path" ]]; then
    printf 'install: failed to publish the install receipt at its exact path\n' >&2
    exit 1
  fi
}
if [[ ! -d "$owners_dir" ]]; then
  printf 'install: shared ownership registry was not initialized\n' >&2
  exit 1
fi
temporary_path=$(mktemp "$owners_dir/.owner.XXXXXX")
printf '%s\n%s\n' "$agent_root" "$skill_root" > "$temporary_path"
chmod 0600 "$temporary_path"
mv -f -- "$temporary_path" "$owners_dir/$agent"
temporary_path=
if [[ "$hooks" == true ]]; then
  publish_install_receipt pending
elif [[ "$hook_enrolled" == true ]]; then
  publish_install_receipt yes
else
  publish_install_receipt no
fi
if [[ "$migrate_legacy_descriptor" == true ]]; then
  rm -f -- "$legacy_descriptor_path"
fi
if [[ "$migrate_legacy_skill" == true ]]; then
  rm -f -- "$legacy_skill_path"
fi
if [[ "$migrate_legacy_descriptor" == true || "$migrate_legacy_skill" == true ]]; then
  rmdir -- "$agent_root/skills/opcore/agents" 2>/dev/null || true
  rmdir -- "$agent_root/skills/opcore" 2>/dev/null || true
fi

rm -rf -- "$preflight_dir"
preflight_dir=
trap - EXIT HUP INT TERM

printf 'installed %s\n' "$installed_binary"
printf 'installed %s skill %s\n' "$agent" "$skill_path"
printf 'verified %s\n' "$("$installed_binary" --version)"
printf 'wrote %s\n' "$manifest_path"
printf 'wrote %s\n' "$native_manifest_path"
printf 'wrote %s\n' "$node_manifest_path"
printf 'wrote %s\n' "$python_manifest_path"
if [[ ${OPCORE_NPM_WRAPPER:-} != 1 && :"$PATH": != *:"$bin_dir":* ]]; then
  printf 'to run the CLI by name in this shell, add Opcore to PATH:\n'
  printf '  export PATH=%q:%s\n' "$bin_dir" "\"\$PATH\""
fi
if [[ "$agent" == codex ]]; then
  printf '%s\n' \
    'Codex normally detects the skill automatically; restart only if this running task does not'
else
  printf 'restart Claude if the skill is not available in the current session\n'
fi
if [[ ${OPCORE_NPM_WRAPPER:-} == 1 ]]; then
  printf 'run the CLI through npm\047s opcore command; keep its private native directory off PATH\n'
else
  printf 'uninstall with:\n'
  printf '  %q --uninstall --agent %q --bin-dir %q\n' \
    "$installed_installer_path" "$agent" "$bin_dir"
fi

)

enroll_agent() (
  agent=$1
  select_context "$agent"
  installed_binary="$bin_dir/opcore"
  install_receipt_path="$agent_root/opcore/install.receipt"
  hook_receipt_path="$agent_root/opcore/hook-install.json"
  hook_config_path="$agent_root/hooks.json"
  if [[ "$agent" == claude ]]; then hook_config_path="$agent_root/settings.json"; fi
  temporary_path=
  trap 'if [[ -n "$temporary_path" ]]; then rm -f -- "$temporary_path"; fi' EXIT
  "$installed_binary" configure-hook \
    --agent "$agent" \
    --config "$hook_config_path" \
    --binary "$installed_binary" \
    --receipt "$hook_receipt_path"
  temporary_path=$(mktemp "$agent_root/opcore/.install.receipt.XXXXXX")
  sed 's/^hooks pending$/hooks yes/' "$install_receipt_path" > "$temporary_path"
  chmod 0600 "$temporary_path"
  mv -f -- "$temporary_path" "$install_receipt_path"
  temporary_path=
  if [[ "$agent" == codex ]]; then
    printf 'configured the Codex PostToolUse hook in %s\n' "$hook_config_path"
    printf 'restart Codex, open /hooks, review this command, and trust it before expecting it to run\n'
  else
    printf 'configured the Claude PostToolUse Verify and Project Sense hook in %s\n' "$hook_config_path"
    printf 'open /hooks to inspect this user-settings hook; it is already active in trusted workspaces\n'
  fi
)

initialize_owner_registry() {
  local candidate
  install -d -m 0700 "$owners_dir"
  for candidate in codex claude; do
    if [[ -e "$owners_dir/$candidate" || -L "$owners_dir/$candidate" ]]; then
      printf 'install: shared ownership slot appeared during initialization\n' >&2
      exit 1
    fi
    shared_slot_temporary=$(mktemp "$owners_dir/.owner.XXXXXX")
    printf '%s\n' "$owner_absent" > "$shared_slot_temporary"
    chmod 0600 "$shared_slot_temporary"
    mv -f -- "$shared_slot_temporary" "$owners_dir/$candidate"
    shared_slot_temporary=
  done
}

# Serialize shared executable ownership across independent agent installers.
install -d "$owners_base"
lock_dir="$owners_dir.lock"
if ! mkdir -- "$lock_dir" 2>/dev/null; then
  printf 'install: another installer holds %s; if interrupted, inspect ownership before removing the lock\n' \
    "$lock_dir" >&2
  exit 1
fi
shared_preflight_dir=
shared_slot_temporary=
cleanup_shared() {
  if [[ -n "$shared_preflight_dir" ]]; then rm -rf -- "$shared_preflight_dir"; fi
  if [[ -n "$shared_slot_temporary" ]]; then rm -f -- "$shared_slot_temporary"; fi
  rmdir -- "$lock_dir"
}
trap cleanup_shared EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$uninstall" == false ]]; then prepare_binary; fi
if ((${#selected_agents[@]} == 2)); then
  select_context codex
  codex_runtime=$agent_root
  codex_skills=$skill_root
  select_context claude
  if [[ "$codex_runtime" == "$agent_root" || "$codex_skills" == "$skill_root" ]]; then
    printf 'install: agents must have distinct runtime and skill destinations\n' >&2
    exit 1
  fi
fi

# Validate all selected destinations before the first agent changes its files.
for selected_agent in "${selected_agents[@]}"; do
  run_agent "$selected_agent" true
done
if [[ "$uninstall" == false && ! -d "$owners_dir" ]]; then
  initialize_owner_registry
fi
for selected_agent in "${selected_agents[@]}"; do
  run_agent "$selected_agent" false
done

if [[ "$uninstall" == false && "$hooks" == true ]]; then
  for selected_agent in "${selected_agents[@]}"; do
    enroll_agent "$selected_agent"
  done
fi
