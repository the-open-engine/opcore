"""Real ast-grep smoke tests for the experimental ASP provider."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from manifest import render as render_manifest


HERE = Path(__file__).resolve().parent
BEFORE = b"def f(x):\n    return x\n"
AFTER = (
    b"def f(x):\n    if x:\n        return True\n"
    b"    else:\n        return False\n"
)


def blob(data: bytes) -> str:
    return "blob:sha256:" + hashlib.sha256(data).hexdigest()


class ProviderTest(unittest.TestCase):
    def run_case(self, before: bytes, after: bytes, comparison: str,
                 configuration: dict | None = None) -> dict:
        scanner = Path(os.environ["AST_GREP_BIN"]).resolve()
        baseline = {"rev": "git:tree:test-baseline"}
        changeset = {"baseline": baseline, "changes": [{
            "path": "src/example.py", "kind": "modify",
            "before": blob(before), "after": blob(after),
        }]}
        blobs = {blob(before): before, blob(after): after}
        process = subprocess.Popen(
            [sys.executable, str(HERE / "provider.py"), "--ast-grep", str(scanner)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )

        def cleanup() -> None:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            process.stdin.close()
            process.stdout.close()

        self.addCleanup(cleanup)

        def send(message: dict) -> None:
            process.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
            process.stdin.flush()

        def receive() -> dict:
            return json.loads(process.stdout.readline())

        send({"id": 1, "method": "initialize", "params": {
            "protocolVersion": "asp/1.0", "host": {"name": "test", "version": "1"},
            "workspace": {"root": "/candidate", "baseline": baseline},
        }})
        initialized = receive()
        self.assertEqual(initialized["result"]["capabilityFamilies"], ["check"])
        self.assertEqual(
            initialized["result"]["serverInfo"]["fingerprint"],
            render_manifest(scanner)["artifact"]["fingerprint"],
        )
        send({"method": "initialized", "params": {
            "baseline": baseline,
            "grantedPermissions": {"read": ["**/*.py"], "write": False,
                                   "network": False, "resourceLimits": {"wallclockMs": 30000}},
        }})
        send({"id": 2, "method": "check/evaluate", "params": {
            "changeset": changeset, "scope": "workspace", "comparison": comparison,
            "configuration": configuration or {},
        }})
        while True:
            message = receive()
            if message.get("id") == 2:
                assessment = message["result"]
                break
            if message["method"] == "workspace/listTree":
                result = {"entries": [{"path": "src/example.py", "blobId": blob(before),
                                       "kind": "file"}], "truncated": False}
            else:
                reference = message["params"]["blobs"][0]
                result = {"blobs": [{"id": reference, "encoding": "utf-8",
                                     "bytes": blobs[reference].decode()}]}
            send({"id": message["id"], "result": result})
        send({"id": 3, "method": "shutdown"})
        self.assertEqual(receive()["result"], None)
        process.wait(timeout=2)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(assessment["status"], "complete")
        expected = [blob(after)] if comparison == "all" else sorted(blobs)
        self.assertEqual(assessment["validAsOf"]["blobs"], expected)
        return assessment

    @unittest.skipUnless(os.environ.get("AST_GREP_BIN"), "set AST_GREP_BIN to pinned scanner")
    def test_introduced_finding(self) -> None:
        assessment = self.run_case(BEFORE, AFTER, "introduced")
        self.assertEqual(len(assessment["diagnostics"]), 1)
        self.assertTrue(assessment["diagnostics"][0]["introduced"])

    @unittest.skipUnless(os.environ.get("AST_GREP_BIN"), "set AST_GREP_BIN to pinned scanner")
    def test_existing_finding_is_not_introduced(self) -> None:
        shifted = b"\n" + AFTER
        assessment = self.run_case(AFTER, shifted, "introduced")
        self.assertEqual(assessment["diagnostics"], [])

    @unittest.skipUnless(os.environ.get("AST_GREP_BIN"), "set AST_GREP_BIN to pinned scanner")
    def test_all_reports_finding(self) -> None:
        assessment = self.run_case(BEFORE, AFTER, "all")
        self.assertEqual(len(assessment["diagnostics"]), 1)

    @unittest.skipUnless(os.environ.get("AST_GREP_BIN"), "set AST_GREP_BIN to pinned scanner")
    def test_repository_configured_rule(self) -> None:
        configuration = {"rules": [{
            "id": "custom-boolean-return", "language": "python", "severity": "warning",
            "message": "Simplify the boolean branches.",
            "rule": {"pattern": "if $COND:\n  return True\nelse:\n  return False"},
        }]}
        assessment = self.run_case(BEFORE, AFTER, "all", configuration)
        self.assertEqual(len(assessment["diagnostics"]), 1)
        self.assertEqual(assessment["diagnostics"][0]["code"],
                         "example-ast-grep/custom-boolean-return")
        self.assertEqual(assessment["diagnostics"][0]["severity"], "warning")


if __name__ == "__main__":
    unittest.main()
