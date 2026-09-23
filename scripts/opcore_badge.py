#!/usr/bin/env python3
"""Render the public full-repository badge from bounded Opcore JSON."""

import argparse
from dataclasses import dataclass
import html
import json
from pathlib import Path
import re
from string import Template


MAX_REPORT_BYTES = 8 * 1024 * 1024
REVISION = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
TEMPLATES = Path(__file__).resolve().parents[1] / ".github" / "badges"
NEGATIVE_DETAILS = {
    "cancelled": "CANCELLED",
    "error": "CHECK ERROR",
    "incomplete": "INCOMPLETE",
    "not_checked": "NOT CHECKED",
    "unsupported": "UNSUPPORTED",
}


@dataclass(frozen=True)
class BadgeState:
    name: str
    template: str
    detail: str = ""
    description: str = ""


def read_report(path):
    """Read one bounded JSON report, returning None for unavailable output."""
    try:
        if not path.is_file() or path.stat().st_size > MAX_REPORT_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def is_unsupported_gap(gap):
    """Accept only the required shape of one unsupported coverage gap."""
    return (
        isinstance(gap, dict)
        and isinstance(gap.get("path"), str)
        and bool(gap["path"])
        and gap.get("status") == "unsupported"
    )


def has_clean_report_shape(status, diagnostics, gaps):
    """Require the terminal fields used by a verified badge."""
    return (
        status == "clean"
        and isinstance(diagnostics, list)
        and diagnostics == []
        and isinstance(gaps, list)
    )


def has_valid_coverage_counts(considered, covered):
    """Reject booleans, empty selections, and negative coverage."""
    return (
        type(considered) is int
        and considered > 0
        and type(covered) is int
        and covered >= 0
    )


def is_clean_report(status, diagnostics, gaps, considered, covered):
    """Require exact, non-empty coverage accounting for the green state."""
    if not has_clean_report_shape(status, diagnostics, gaps):
        return False
    if not has_valid_coverage_counts(considered, covered):
        return False
    if not all(is_unsupported_gap(gap) for gap in gaps):
        return False
    paths = [gap["path"] for gap in gaps]
    return len(paths) == len(set(paths)) and covered + len(gaps) == considered


def finding_count(status, diagnostics):
    """Return a positive, bounded diagnostic count only for a findings report."""
    if status != "findings" or not isinstance(diagnostics, list) or not diagnostics:
        return None
    return len(diagnostics)


def classify(report):
    """Map an Opcore report to the narrow public badge states."""
    if report is None:
        return BadgeState(
            "check_failed",
            "not-verified.svg",
            "CHECK FAILED",
            "The full repository check did not produce a valid report.",
        )

    status = report.get("status")
    diagnostics = report.get("diagnostics")
    coverage = report.get("coverage")
    gaps = coverage.get("gaps") if isinstance(coverage, dict) else None
    considered = coverage.get("filesConsidered") if isinstance(coverage, dict) else None
    covered = coverage.get("filesCovered") if isinstance(coverage, dict) else None

    if is_clean_report(status, diagnostics, gaps, considered, covered):
        return BadgeState("verified", "verified.svg")

    count = finding_count(status, diagnostics)
    if count is not None:
        noun = "FINDING" if count == 1 else "FINDINGS"
        return BadgeState(
            "findings",
            "not-verified.svg",
            f"{count} {noun}",
            f"The full repository check reported {count} {noun.lower()}.",
        )

    detail = NEGATIVE_DETAILS.get(status, "INCOMPLETE")
    return BadgeState(
        "not_verified",
        "not-verified.svg",
        detail,
        f"The full repository check is not verified: {detail.lower()}.",
    )


def render(report, revision, exit_code=0):
    """Render a validated state with XML-escaped dynamic values."""
    if REVISION.fullmatch(revision) is None:
        raise ValueError("revision must be a 40- or 64-character lowercase Git object ID")
    state = classify(report)
    if state.name == "verified" and exit_code != 0:
        state = BadgeState(
            "check_failed",
            "not-verified.svg",
            "CHECK FAILED",
            "The full repository check returned a nonzero exit status.",
        )
    template = Template((TEMPLATES / state.template).read_text(encoding="utf-8"))
    values = {
        "revision": html.escape(revision, quote=True),
        "detail": html.escape(state.detail, quote=True),
        "description": html.escape(state.description, quote=True),
    }
    return state, template.substitute(values)


def write_badge(report_path, output, revision, exit_code=0):
    """Atomically render one badge into the caller-selected output path."""
    state, badge = render(read_report(report_path), revision, exit_code)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(badge, encoding="utf-8")
    temporary.replace(output)
    return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    options = parser.parse_args()
    state = write_badge(
        options.report,
        options.output,
        options.revision,
        options.exit_code,
    )
    print(f"opcore badge: {state.name}")


if __name__ == "__main__":
    main()
