#!/usr/bin/env python3
"""Small experimental ASP check provider backed by ast-grep rules.

This is a separate provider, not a new Opcore CLI profile or an ASP outer host.
It accepts only host callback bytes and never reads a candidate repository path.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time

from manifest import render as render_manifest


ROOT = Path(__file__).resolve().parent
RULES = ROOT / "rules.yaml"
SOURCE = "example-ast-grep"
RULE = f"{SOURCE}/redundant-boolean-return"
VERSION = "0.1.0"
MAX_FILES = 1000
MAX_BYTES = 16 * 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
MAX_CONFIGURATION = 64 * 1024
MAX_RULES = 16


class ProviderFailure(Exception):
    """A scanner or callback failure, distinct from invalid request input."""


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def frame(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_frame() -> dict:
    line = sys.stdin.readline()
    if not line or len(line) > MAX_OUTPUT:
        raise ValueError("missing or oversized JSON-RPC frame")
    value = json.loads(line)
    if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
        raise ValueError("invalid JSON-RPC frame")
    return value


def callback(method: str, params: dict, sequence: list[int]) -> dict:
    sequence[0] += 1
    identifier = f"ast-grep:{sequence[0]}"
    frame({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
    response = read_frame()
    if response.get("id") != identifier or "error" in response:
        raise ProviderFailure(f"{method} callback failed")
    result = response.get("result")
    if not isinstance(result, dict):
        raise ProviderFailure(f"{method} returned an invalid result")
    return result


def safe_path(raw: object) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        raise ValueError("invalid source path")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in ("", ".", "..") for part in raw.split("/")):
        raise ValueError("source path escapes workspace")
    return raw


def read_blob(reference: str, sequence: list[int], reads: set[str]) -> bytes:
    result = callback("workspace/readBlob", {"blobs": [reference]}, sequence)
    blobs = result.get("blobs")
    if not isinstance(blobs, list) or len(blobs) != 1 or blobs[0].get("id") != reference:
        raise ProviderFailure("readBlob returned an unexpected blob")
    blob = blobs[0]
    if blob.get("encoding") == "base64":
        data = base64.b64decode(blob["bytes"], validate=True)
    elif blob.get("encoding") == "utf-8":
        data = blob["bytes"].encode("utf-8")
    else:
        raise ProviderFailure("unsupported blob encoding")
    if "blob:" + digest(data) != reference:
        raise ProviderFailure("readBlob content hash mismatch")
    reads.add(reference)
    return data


def configured_rules(configuration: object) -> tuple[list[dict], dict[str, dict], str]:
    """Validate bounded declarative rules; never accept a scanner command or path."""
    if configuration == {}:
        return [], {"redundant-boolean-return": {
            "message": "Boolean branches return constants; consider a boolean expression.",
            "severity": "error",
        }}, digest(canonical({"configuration": {}, "rulePack": digest(RULES.read_bytes())}))
    if not isinstance(configuration, dict) or set(configuration) != {"rules"}:
        raise ValueError("configuration must contain only rules")
    if len(canonical(configuration)) > MAX_CONFIGURATION:
        raise ValueError("rule configuration exceeds byte bound")
    rules = configuration["rules"]
    if not isinstance(rules, list) or not 1 <= len(rules) <= MAX_RULES:
        raise ValueError("rules must be a nonempty bounded list")
    definitions = {}
    for rule in rules:
        identifier = validate_rule(rule)
        if identifier in definitions:
            raise ValueError("duplicate rule id")
        definitions[identifier] = rule
    return rules, definitions, digest(canonical(configuration))


def validate_rule(rule: object) -> str:
    if not isinstance(rule, dict) or set(rule) != {
        "id", "language", "severity", "message", "rule"
    }:
        raise ValueError("rule has unknown or missing fields")
    identifier = rule["id"]
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", identifier):
        raise ValueError("invalid rule id")
    validate_rule_body(rule)
    return identifier


def validate_rule_body(rule: dict) -> None:
    if rule["language"] != "python" or rule["severity"] not in ("error", "warning", "info"):
        raise ValueError("unsupported rule language or severity")
    if not isinstance(rule["message"], str) or not 1 <= len(rule["message"]) <= 300:
        raise ValueError("invalid rule message")
    if not isinstance(rule["rule"], dict) or not rule["rule"]:
        raise ValueError("invalid ast-grep rule")


def scan(sg: Path, files: dict[str, bytes], rules: list[dict]) -> list[dict]:
    if not files:
        return []
    with tempfile.TemporaryDirectory(prefix="asp-ast-grep-") as directory:
        base = Path(directory)
        paths = []
        for name, data in sorted(files.items()):
            target = base / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            paths.append(str(target))
        rule_args = (["--inline-rules", "\n---\n".join(json.dumps(rule) for rule in rules)]
                     if rules else ["--rule", str(RULES)])
        completed = subprocess.run(
            [str(sg), "scan", "--json=compact", "--threads", "1", *rule_args, *paths],
            capture_output=True,
            timeout=30,
            check=False,
        )
        return parse_scan_result(completed, base)


def parse_scan_result(completed: subprocess.CompletedProcess, base: Path) -> list[dict]:
    if completed.returncode not in (0, 1) or len(completed.stdout) > MAX_OUTPUT:
        raise ProviderFailure("ast-grep scan failed or exceeded output bound")
    try:
        matches = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise ProviderFailure("ast-grep returned invalid JSON") from error
    if not isinstance(matches, list):
        raise ProviderFailure("ast-grep returned an invalid match list")
    if completed.returncode == 1 and (
        not matches
        or b"Scan succeeded and found error level diagnostics" not in completed.stderr
    ):
        raise ProviderFailure("ast-grep exited unsuccessfully")
    for match in matches:
        path = Path(match["file"])
        if not path.is_relative_to(base):
            raise ProviderFailure("ast-grep returned an out-of-scope path")
        match["file"] = path.relative_to(base).as_posix()
    return matches


def match_key(match: dict) -> tuple[str, str, str]:
    # Line movement does not create a new finding. Repeated identical matches
    # are compared as a multiset rather than collapsed to one fingerprint.
    return (match["file"], match["ruleId"], " ".join(match["text"].split()))


def request_part(params: dict, baseline: dict) -> tuple[dict, bool, list[dict], dict[str, dict], str]:
    allowed = {
        "changeset", "scope", "comparison", "configuration",
        "diagnosticSources", "rules",
    }
    validate_request_envelope(params, baseline, allowed)
    rule_pack, definitions, config_digest = configured_rules(params.get("configuration", {}))
    comparison = params["comparison"]
    scope = params["scope"]
    sources = params.get("diagnosticSources") or [SOURCE]
    available = [f"{SOURCE}/{name}" for name in definitions]
    rules = params.get("rules") or available
    part = {
        "scope": scope, "diagnosticSources": sources,
        "rules": rules, "comparison": comparison,
    }
    supported = supported_request(scope, comparison, sources, rules, available)
    selected = set(rules) if supported else set()
    selected_pack = [rule for rule in rule_pack if f"{SOURCE}/{rule['id']}" in selected]
    selected_defs = {name: definition for name, definition in definitions.items()
                     if f"{SOURCE}/{name}" in selected}
    return part, supported, selected_pack, selected_defs, config_digest


def validate_request_envelope(params: dict, baseline: dict, allowed: set[str]) -> None:
    if set(params) - allowed:
        raise ValueError("unknown check/evaluate field")
    if params["changeset"]["baseline"] != baseline:
        raise ValueError("stale baseline")


def supported_request(scope: object, comparison: object, sources: object,
                      rules: object, available: list[str]) -> bool:
    if scope not in ("workspace", "changeset") or comparison not in ("all", "introduced"):
        return False
    if sources != [SOURCE] or not isinstance(rules, list) or not rules:
        return False
    return len(rules) == len(set(rules)) and set(rules).issubset(available)


def baseline_ids(baseline: dict, sequence: list[int]) -> dict:
    listing = callback("workspace/listTree", {"baseline": baseline}, sequence)
    if listing.get("truncated") or not isinstance(listing.get("entries"), list):
        raise ProviderFailure("incomplete baseline listing")
    before = {}
    for entry in listing["entries"]:
        name = safe_path(entry["path"])
        if entry.get("kind") == "file" and name.endswith(".py"):
            before[name] = entry["blobId"]
    return before


def apply_changes(before: dict, changes: list[dict]) -> tuple[dict, set[str]]:
    after = dict(before)
    changed = set()
    for change in changes:
        name = safe_path(change["path"])
        if change["kind"] == "rename":
            previous = safe_path(change["from"])
            after.pop(previous, None)
            changed.add(previous)
        if change["kind"] == "delete":
            after.pop(name, None)
        else:
            after[name] = change["after"]
        changed.add(name)
    return after, changed


def source_ids(changeset: dict, scope: str, baseline: dict, sequence: list[int]) -> tuple[dict, dict]:
    before = baseline_ids(baseline, sequence)
    after, changed = apply_changes(before, changeset["changes"])
    selected = set(before) | set(after) if scope == "workspace" else changed
    if len(selected) > MAX_FILES:
        raise ValueError("source file bound exceeded")
    old = {name: before[name] for name in selected & before.keys() if name.endswith(".py")}
    new = {name: after[name] for name in selected & after.keys() if name.endswith(".py")}
    return old, new


def scan_views(
    sg: Path, views: tuple[dict, dict], comparison: str, sequence: list[int], rules: list[dict],
) -> tuple[list[dict], Counter, set[str]]:
    old, new = views
    references = set(new.values())
    if comparison == "introduced":
        references.update(old.values())
    if len(references) > MAX_FILES:
        raise ValueError("source blob bound exceeded")
    reads: set[str] = set()
    blobs = {ref: read_blob(ref, sequence, reads) for ref in sorted(references)}
    if sum(map(len, blobs.values())) > MAX_BYTES:
        raise ValueError("source byte bound exceeded")
    current = scan(sg, {name: blobs[ref] for name, ref in new.items()}, rules)
    previous = Counter()
    if comparison == "introduced":
        old_files = {name: blobs[ref] for name, ref in old.items()}
        previous = Counter(match_key(item) for item in scan(sg, old_files, rules))
    return current, previous, reads


def make_diagnostics(matches: list[dict], previous: Counter, comparison: str,
                     definitions: dict[str, dict]) -> list[dict]:
    diagnostics = []
    for match in matches:
        rule_id = match.get("ruleId")
        if rule_id not in definitions:
            raise ProviderFailure("scanner returned an unknown rule")
        key = match_key(match)
        if previous[key]:
            previous[key] -= 1
            continue
        start = match["range"]["start"]
        end = match["range"]["end"]
        diagnostics.append({
            "code": f"{SOURCE}/{rule_id}",
            "severity": definitions[rule_id]["severity"], "source": SOURCE,
            "message": definitions[rule_id]["message"],
            "location": {"path": match["file"], "range": {
                "start": {"line": start["line"], "char": start["column"]},
                "end": {"line": end["line"], "char": end["column"]},
            }},
            "fingerprint": digest(canonical(key)),
            "introduced": comparison == "introduced",
        })
    return diagnostics


def assess(params: dict, baseline: dict, sg: Path, sequence: list[int], build: str) -> dict:
    started = time.monotonic()
    part, supported, rules, definitions, config_digest = request_part(params, baseline)
    reads: set[str] = set()
    diagnostics = []
    if supported:
        old, new = source_ids(params["changeset"], part["scope"], baseline, sequence)
        current, previous, reads = scan_views(sg, (old, new), part["comparison"], sequence, rules)
        diagnostics = make_diagnostics(current, previous, part["comparison"], definitions)
    coverage = {
        "requested": part,
        "covered": part if supported else {**part, "diagnosticSources": [], "rules": []},
        "degraded": [],
        "unsupported": [] if supported else [{
            "source": SOURCE, "reason": "unsupported",
            "detail": "Only configured Python rules and all/introduced comparisons are supported.",
        }],
        "exhaustive": supported,
        "truncated": False,
    }
    return {
        "status": "complete" if supported else "unsupported",
        "diagnostics": diagnostics,
        "coverage": coverage,
        "validAsOf": {
            "baseline": baseline,
            "changesetDigest": digest(canonical(params["changeset"])),
            "blobs": sorted(reads),
        },
        "provider": {
            "id": SOURCE, "version": VERSION,
            "configDigest": config_digest,
            "capabilityVersion": "check/1.0", "buildDigest": build,
            "capabilityFamily": "check",
        },
        "timing": {"elapsedMs": int((time.monotonic() - started) * 1000)},
        "cache": {"status": "disabled"},
    }


def initialize_result(build: str) -> dict:
    return {
        "serverInfo": {"name": "Example AST-grep", "version": VERSION, "fingerprint": build},
        "capabilityFamilies": ["check"],
        "roles": ["judge"],
        "capabilities": {"check": {
            "capabilityVersion": "check/1.0", "diagnosticSources": [SOURCE],
            "scopes": ["workspace", "changeset"],
            "comparisons": ["all", "introduced"],
            "partialResults": False, "incremental": False,
            "unsupportedReporting": "assessment-status", "fixes": False,
        }},
        "requestedPermissions": {
            "read": ["**/*.py", "*.py"], "write": False, "network": False,
        },
    }


def accept_initialize(params: dict, state: dict) -> dict:
    if params["protocolVersion"] != "asp/1.0":
        raise ValueError("unsupported protocol version")
    state["baseline"] = params["workspace"]["baseline"]
    return initialize_result(state["build"])


def accept_grant(grant: dict, state: dict) -> None:
    permissions = grant["grantedPermissions"]
    if grant["baseline"] != state["baseline"]:
        raise ValueError("invalid initialized baseline")
    if permissions.get("write") or permissions.get("network"):
        raise ValueError("invalid initialized grant")
    state["initialized"] = True


def dispatch(request: dict, state: dict, sg: Path) -> object:
    method = request.get("method")
    if method == "initialize" and state["baseline"] is None:
        return accept_initialize(request["params"], state)
    if method == "initialized" and state["baseline"] is not None:
        accept_grant(request["params"], state)
        return None
    if state["initialized"]:
        if method == "check/evaluate":
            result = assess(request["params"], state["baseline"], sg,
                            state["sequence"], state["build"])
            if render_manifest(sg)["artifact"]["fingerprint"] != state["build"]:
                raise ProviderFailure("provider or scanner changed during evaluation")
            return result
        if method == "shutdown":
            state["shutdown"] = True
            return None
    raise ValueError("invalid lifecycle method or state")


def serve(sg: Path) -> None:
    if not sg.is_absolute() or not sg.is_file():
        raise ValueError("--ast-grep must name an absolute executable")
    sg = sg.resolve(strict=True)
    build = render_manifest(sg)["artifact"]["fingerprint"]
    state = {"baseline": None, "initialized": False, "shutdown": False,
             "sequence": [0], "build": build}
    while not state["shutdown"]:
        try:
            request = read_frame()
        except ValueError:
            return
        if request.get("method") == "exit":
            return
        identifier = request.get("id")
        try:
            result = dispatch(request, state, sg)
            if identifier is not None:
                frame({"jsonrpc": "2.0", "id": identifier, "result": result})
        except (KeyError, TypeError, ValueError, ProviderFailure,
                subprocess.TimeoutExpired) as error:
            if identifier is not None:
                fail_class = (
                    "health" if isinstance(error, (ProviderFailure, subprocess.TimeoutExpired))
                    else "input"
                )
                frame({"jsonrpc": "2.0", "id": identifier, "error": {
                    "code": -32013, "message": "provider evaluation failed",
                    "data": {"failClass": fail_class, "retryable": False,
                             "detail": str(error)[:200]},
                }})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ast-grep", type=Path, required=True)
    serve(parser.parse_args().ast_grep)
