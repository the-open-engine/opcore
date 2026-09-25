#!/usr/bin/env python3
"""Render an experimental ASP manifest for this provider and exact scanner bytes."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys


HERE = Path(__file__).resolve().parent


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(scanner: Path) -> dict:
    scanner = scanner.resolve(strict=True)
    python = Path(sys.executable).resolve(strict=True)
    paths = [python, HERE / "provider.py", HERE / "rules.yaml",
             HERE / "manifest.py", scanner]
    checksums = [{"path": str(path), "sha256": file_hash(path)} for path in paths]
    identity = json.dumps(checksums, sort_keys=True, separators=(",", ":")).encode()
    return {
        "manifestVersion": "asp-server/1.0",
        "server": {"id": "example-ast-grep", "name": "Example AST-grep", "version": "0.1.0"},
        "protocolVersions": ["asp/1.0"],
        "roles": ["judge"],
        "capabilities": ["check"],
        "capabilityProfiles": ["example-ast-grep/python-redundancy"],
        "entrypoint": {"transport": "stdio", "bin": str(python),
                       "args": [str(HERE / "provider.py"), "--ast-grep", str(scanner)]},
        "artifact": {"fingerprint": "sha256:" + hashlib.sha256(identity).hexdigest(),
                     "checksums": checksums},
        "provenance": {"publisher": "the-open-engine", "source":
                       "https://github.com/the-open-engine/opcore/tree/main/contrib/asp-ast-grep",
                       "license": "Apache-2.0"},
        "accessExpectations": {
            "filesystem": {"read": ["provider-artifacts"],
                           "write": ["provider-private-scratch"]},
            "network": {"outbound": False, "allowlist": []},
            "secrets": {"names": []},
            "environment": {"inherit": False, "variables": []},
            "dataClasses": ["source-code", "diff-metadata"],
        },
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python manifest.py /absolute/path/to/ast-grep")
    print(json.dumps(render(Path(sys.argv[1])), indent=2))
