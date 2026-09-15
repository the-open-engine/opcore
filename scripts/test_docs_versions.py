"""Regression checks for release immutability and documentation URL compatibility."""

import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from docs_versions import compose, ROUTES, STATE


class DocumentationVersions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.snapshot = self.root / "snapshot"
        self.snapshot.mkdir()
        (self.snapshot / ".opcore-docs").touch()
        (self.snapshot / "assets").mkdir()
        (self.snapshot / "assets/site.css").write_text("body { color: black; }")
        for route in ROUTES.values():
            path = self.snapshot / (route or "index.html")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                '<html><head><title>Example</title></head><body>'
                '<div class="header-actions"></div><main id="example">First build</main></body></html>'
            )
        self.published = None
        self.counter = 0

    def options(self, version="dev", commit="a" * 40, stable=False):
        self.counter += 1
        return SimpleNamespace(
            snapshot=self.snapshot,
            published=self.published,
            output=self.root / f"publication-{self.counter}",
            version=version,
            product_version="0.3.0" if version == "dev" else version[1:],
            source_commit=commit,
            publisher_commit="b" * 40,
            stable=stable,
        )

    def publish(self, version="dev", commit="a" * 40, stable=False):
        options = self.options(version, commit, stable)
        compose(options)
        self.published = options.output
        return options.output

    @staticmethod
    def files(root):
        return {path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()}

    def test_initial_development_has_manifest_selector_and_fallback(self):
        site = self.publish()
        self.assertIn("dev/index.html", (site / "index.html").read_text())
        manifest = json.loads((site / "dev/manifest.json").read_text())
        self.assertIsNone(manifest["productVersion"])
        self.assertEqual(manifest["sourceCommit"], "a" * 40)
        self.assertEqual(manifest["routes"]["cli"], "cli.html")
        page = (site / "dev/api/opcore/api/index.html").read_text()
        self.assertIn("../../../../versions.html", page)
        self.assertIn('aria-label="Documentation version"', page)
        self.assertIn("Development", (site / "versions.html").read_text())

    def test_release_and_later_dev_preserve_stable_bytes(self):
        self.publish()
        site = self.publish("v0.3.0", stable=True)
        original = self.files(site / "v0.3.0")
        (self.snapshot / "cli.html").write_text("<html><body>Changed development CLI</body></html>")
        site = self.publish(commit="c" * 40)
        self.assertEqual(original, self.files(site / "v0.3.0"))
        self.assertIn("stable/index.html", (site / "index.html").read_text())
        self.assertIn("../v0.3.0/index.html", (site / "stable/index.html").read_text())
        self.assertIn("Changed development CLI", (site / "dev/cli.html").read_text())

    def test_repeat_release_preserves_snapshot_even_with_new_publisher(self):
        site = self.publish("v0.3.0", stable=True)
        original = self.files(site / "v0.3.0")
        (self.snapshot / "index.html").write_text("A changed renderer must not replace the release")
        options = self.options("v0.3.0", stable=True)
        options.publisher_commit = "c" * 40
        compose(options)
        self.assertEqual(original, self.files(options.output / "v0.3.0"))

    def test_release_rejects_another_source_without_changing_published_tree(self):
        site = self.publish("v0.3.0", stable=True)
        original = self.files(site)
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.publish("v0.3.0", commit="c" * 40)
        self.assertEqual(original, self.files(site))

    def test_stable_recovery_and_numeric_version_order(self):
        self.publish("v0.3.2", stable=True)
        site = self.publish("v0.3.10", commit="c" * 40)
        self.assertIn("../v0.3.2/index.html", (site / "stable/index.html").read_text())
        site = self.publish("v0.3.10", commit="c" * 40, stable=True)
        self.assertIn("../v0.3.10/index.html", (site / "stable/index.html").read_text())
        entries = json.loads((site / "versions.json").read_text())
        self.assertEqual([entry["version"] for entry in entries], ["v0.3.10", "v0.3.2"])
        with self.assertRaisesRegex(ValueError, "backwards"):
            self.publish("v0.3.2", stable=True)

    def test_old_deep_links_keep_paths_query_and_fragment(self):
        site = self.publish("v0.3.0", stable=True)
        legacy = (site / "docs/getting-started.html").read_text()
        alias = (site / "stable/docs/getting-started.html").read_text()
        self.assertIn("../stable/docs/getting-started.html", legacy)
        self.assertIn("../../v0.3.0/docs/getting-started.html", alias)
        self.assertIn("location.search + location.hash", legacy)
        self.assertIn("location.search + location.hash", alias)
        self.assertEqual(
            (site / "stable/manifest.json").read_bytes(),
            (site / "v0.3.0/manifest.json").read_bytes(),
        )

    def test_rustdoc_source_ranges_work_inside_version_directories(self):
        source = self.snapshot / "api/src/opcore/api.rs.html"
        source.parent.mkdir(parents=True)
        source.write_text('<span id="1">one</span><span id="3">three</span>')
        (self.snapshot / "api/opcore/api/index.html").write_text(
            '<a href="../../src/opcore/api.rs.html#1-3">Source</a>'
        )
        spec = importlib.util.spec_from_file_location(
            "docs_builder", Path(__file__).with_name("build-docs.py")
        )
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        builder.check_links(self.snapshot)
        site = self.publish("v0.3.0", stable=True)
        builder.check_links(site)
        (site / "v0.3.0/api/src/opcore/api.rs.html").write_text('<span id="1">one</span>')
        with self.assertRaisesRegex(ValueError, "missing anchor"):
            builder.check_links(site)

    def test_development_cannot_be_stable(self):
        with self.assertRaisesRegex(ValueError, "cannot become stable"):
            self.publish(stable=True)

    def test_unsafe_versions_and_wrong_product_are_rejected(self):
        for version in ("../elsewhere", "v01.2.3", "stable", "v1.2.3-rc.1"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.publish(version)
        options = self.options("v0.3.0")
        options.product_version = "0.2.2"
        with self.assertRaisesRegex(ValueError, "product version"):
            compose(options)

    def test_missing_route_cannot_publish(self):
        (self.snapshot / "cli.html").unlink()
        with self.assertRaisesRegex(ValueError, "required route"):
            self.publish()

    def test_symlinks_are_rejected(self):
        (self.snapshot / "escape").symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "non-regular"):
            self.publish()

    def test_modified_history_is_rejected(self):
        site = self.publish("v0.3.0")
        (site / "v0.3.0/cli.html").write_text("Modified after publication")
        with self.assertRaisesRegex(ValueError, "has changed"):
            self.publish()

    def test_unknown_state_and_output_replacement_are_rejected(self):
        self.published = self.root / "unowned"
        self.published.mkdir()
        (self.published / "index.html").write_text("Existing unrelated site")
        with self.assertRaises(FileNotFoundError):
            self.publish()
        self.published = None
        options = self.options()
        options.output.mkdir()
        with self.assertRaisesRegex(ValueError, "new directory"):
            compose(options)

    def test_redirect_state_cannot_delete_a_release_file(self):
        site = self.publish("v0.3.0")
        state = json.loads((site / STATE).read_text())
        state["rootPages"].append("v0.3.0/index.html")
        (site / STATE).write_text(json.dumps(state))
        with self.assertRaisesRegex(ValueError, "cannot replace version"):
            self.publish()


if __name__ == "__main__":
    unittest.main()
