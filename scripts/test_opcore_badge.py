"""Regression checks for the public full-repository badge."""

import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree

from opcore_badge import render, write_badge


REVISION = "a" * 40


def report(status="clean", diagnostics=None, considered=3, covered=3, gaps=None):
    return {
        "status": status,
        "diagnostics": [] if diagnostics is None else diagnostics,
        "coverage": {
            "filesConsidered": considered,
            "filesCovered": covered,
            "gaps": [] if gaps is None else gaps,
        },
    }


class OpcoreBadge(unittest.TestCase):
    def badge(self, value):
        state, badge = render(value, REVISION)
        root = ElementTree.fromstring(badge)
        text = " ".join(root.itertext())
        self.assertEqual(root.attrib["data-revision"], REVISION)
        return state, badge, text

    def test_clean_full_repository_is_verified(self):
        state, badge, text = self.badge(report())
        self.assertEqual(state.name, "verified")
        self.assertIn("OPCORE VERIFIED", text)
        self.assertIn("FULL REPO · CLEAN", text)
        self.assertIn("11.75,7.907 22.25,7.907 27.5,17", badge)

    def test_unsupported_coverage_warnings_do_not_change_the_badge(self):
        state, _, text = self.badge(
            report(
                covered=2,
                gaps=[
                    {
                        "path": "scripts/check.ps1",
                        "status": "unsupported",
                        "reason": "unsupported language",
                    }
                ],
            )
        )
        self.assertEqual(state.name, "verified")
        self.assertIn("FULL REPO · CLEAN", text)
        self.assertNotIn("WARNING", text.upper())
        self.assertNotIn("UNSUPPORTED", text.upper())

    def test_findings_report_the_exact_diagnostic_count(self):
        state, badge, text = self.badge(report("findings", [{}, {}, {}]))
        self.assertEqual(state.name, "findings")
        self.assertIn("OPCORE NOT VERIFIED", text)
        self.assertIn("FULL REPO · 3 FINDINGS", text)
        self.assertIn("m12.8 12.8 8.4 8.4", badge)

    def test_one_finding_uses_the_singular_label(self):
        state, badge = render(report("findings", [{}]), REVISION, exit_code=1)
        text = " ".join(ElementTree.fromstring(badge).itertext())
        self.assertEqual(state.name, "findings")
        self.assertIn("FULL REPO · 1 FINDING", text)

    def test_nonzero_clean_process_cannot_publish_green(self):
        state, badge = render(report(), REVISION, exit_code=1)
        text = " ".join(ElementTree.fromstring(badge).itertext())
        self.assertEqual(state.name, "check_failed")
        self.assertIn("FULL REPO · CHECK FAILED", text)

    def test_empty_or_incomplete_clean_report_is_not_green(self):
        cases = [
            report(considered=0, covered=0),
            report(covered=2),
            {
                "status": "clean",
                "diagnostics": [],
                "coverage": {
                    "filesConsidered": 3,
                    "filesCovered": 3,
                    "gaps": None,
                },
            },
            report(gaps=[{"reason": "unsupported"}]),
            report(covered=2, gaps=[{"status": "unsupported"}]),
            report(
                considered=2,
                covered=0,
                gaps=[
                    {"path": "same.ps1", "status": "unsupported"},
                    {"path": "same.ps1", "status": "unsupported"},
                ],
            ),
            report(
                covered=2,
                gaps=[{"status": "incomplete", "reason": "truncated output"}],
            ),
            report(diagnostics=[{}]),
        ]
        for value in cases:
            with self.subTest(value=value):
                state, _, text = self.badge(value)
                self.assertEqual(state.name, "not_verified")
                self.assertIn("FULL REPO · INCOMPLETE", text)

    def test_nonterminal_statuses_remain_not_verified(self):
        for status, detail in (
            ("not_checked", "NOT CHECKED"),
            ("unsupported", "UNSUPPORTED"),
            ("incomplete", "INCOMPLETE"),
            ("cancelled", "CANCELLED"),
            ("error", "CHECK ERROR"),
        ):
            with self.subTest(status=status):
                state, _, text = self.badge(report(status))
                self.assertEqual(state.name, "not_verified")
                self.assertIn(f"FULL REPO · {detail}", text)

    def test_missing_or_malformed_output_becomes_check_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "badge.svg"
            state = write_badge(root / "missing.json", output, REVISION)
            self.assertEqual(state.name, "check_failed")
            self.assertIn("FULL REPO · CHECK FAILED", output.read_text())
            (root / "bad.json").write_text("{")
            state = write_badge(root / "bad.json", output, REVISION)
            self.assertEqual(state.name, "check_failed")

    def test_report_size_and_revision_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "report.json"
            output = root / "badge.svg"
            source.write_text(json.dumps(report()))
            with self.assertRaisesRegex(ValueError, "revision"):
                write_badge(source, output, "main")


if __name__ == "__main__":
    unittest.main()
