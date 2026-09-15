# Contributing

## Report a problem

Use [GitHub Issues](https://github.com/the-open-engine/opcore/issues) for reproducible bugs and feature requests. Include the Opcore version, operating system and architecture, and installation method. For check failures, give the exact command, selected workflow, and a small Git fixture; attach relevant JSON and `status --workflow <name> --json` output. Include configuration and whether its changes were staged. For setup failures, include `opcore doctor --repo . --json` and the installer's error; npm diagnostics work even when native setup is incomplete. Review output for private paths or source before posting.

If automatic checks aren't firing, say which agent and editing tool you used and whether the [activation smoke test](docs/getting-started.md#confirm-hook-activation) reached the hook. Doctor's configuration check alone doesn't establish host activation.

## Work on the source

Read the checkout's [AGENTS.md](https://github.com/the-open-engine/opcore/blob/main/AGENTS.md) before changing implementation. It records the product boundary and required checks. [Architecture](docs/architecture.md) and [acceptance criteria](docs/acceptance.md) explain the implementation contracts; the [user guides](README.md) cover expected behavior.

The checkout pins its development toolchain in `rust-toolchain.toml`. It also needs a C compiler/linker and Git. Format changes and run the relevant tests while working:

```sh
cargo fmt --all -- --check
cargo test --workspace --all-features --locked
```

Before handoff, complete the applicable verification in AGENTS.md, including the Rust 1.95 compatibility check, Clippy, dependency policy, and installer/provider tests when affected. Missing cargo-deny or another required tool is a prerequisite to resolve. Use the existing test infrastructure; a documentation correction usually needs its examples and links checked rather than a new implementation-mirroring test.

Open a pull request that states the user-visible problem, resulting behavior, and validation. Keep unrelated changes separate. Changes to architecture, protocol behavior, language coverage, cache identity, or verification conventions also require an AGENTS.md update.

## Build the documentation

This local build needs the repository's Rust toolchain and Python 3.9 or newer. The Python helper uses only the standard library.

```sh
./scripts/build-docs.sh
```

Open `target/site/index.html` locally. The build renders the overview and guides, derives the CLI reference from the Rust command definitions, and includes rustdoc for the public API and every provider profile. CI runs this build for pull requests and release tags. After a successful push-triggered CI run, the documentation publisher rebuilds that exact source for `dev` or its immutable release version on [GitHub Pages](https://the-open-engine.github.io/opcore/). Local builds do not deploy.

Edit command and API documentation beside the Rust definitions, then regenerate the site. Keep setup and workflow explanations in the Markdown guides. `opcore rules --schema` generates the repository configuration's editor schema from the implementation; keep its constraints consistent with runtime validation. Generated site files stay under `target/` and don't belong in a commit. For the protocol's wire definition, follow [asp/README.md](asp/README.md).

## Publish a release

The repository is `the-open-engine/opcore`, and the public npm package is `@the-open-engine-company/opcore`. Preserve the `legacy` branch and published tags. The first replacement release is `v0.3.0`; never reuse an earlier tag or package version.

Before the first npm release, an npm organization owner must reserve the package or supply the one-time bootstrap credential through the GitHub `release` environment's `NPM_TOKEN` secret. Configure the package's GitHub trusted publisher with organization `the-open-engine`, repository `opcore`, workflow filename `ci.yml`, environment `release`, and permission for direct `npm publish`. A normal release uses OIDC; remove the bootstrap token after that setup succeeds. Keep immutable GitHub releases enabled and protect release tags against modification and deletion.

Set the Cargo package and lockfile version, merge the reviewed change after CI passes, then push the matching stable `vX.Y.Z` tag. CI builds both platforms, stages matching npm metadata and checksums, and tests the packed artifact. It uploads all assets to a draft before publishing the immutable GitHub Release, then exercises the packed install against those assets and publishes that exact npm tarball. If publication fails after the GitHub Release exists, preserve its assets and diagnose the failed step before retrying; the job refuses to replace an existing release.

GitHub Pages must use the GitHub Actions publishing source. Restrict the `github-pages` environment to `main`. Automatic documentation publication follows successful CI, including npm publication for a release tag. The separate `docs.yml` workflow stores immutable `vX.Y.Z` snapshots, mutable `dev` docs, and the `stable` alias on `gh-pages`. See [Documentation versions](docs/versioning.md) for the URL contract, exact-source recovery commands, and initialization from `v0.3.0`. Run `python3 -B -m unittest discover -s scripts -p 'test_docs_versions.py'` when changing the publisher. Verify version switching, old deep links, a guide, the CLI reference, and the public API before handoff.
