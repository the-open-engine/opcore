# Experimental AST-grep ASP provider

This directory is a separate ASP `check/1.0` provider example. It is not a fifth
Opcore profile, an Opcore plugin loader, or an ASP outer host. Opcore's `check`
command cannot enroll it. A conforming outer host must enroll this provider
alongside `opcore serve --stdio`, grant source callbacks, verify the assessments,
and own any decision. The local smoke tests exercise the provider side of that
boundary; they are not ASP Core adoption evidence.

The pinned example uses `@ast-grep/cli` **0.45.3** and accepts up to 16
declarative Python rules in the ASP `check/evaluate.configuration` object.
With an empty configuration it uses the packaged constant-boolean-return
example rule. Its diagnostics
have `error` severity but remain advisory unless an external host explicitly
enrolls this provider as a gate. The
provider only reads source through `workspace/listTree` and `workspace/readBlob`,
scans private temporary copies, and returns diagnostics with content-bound
freshness evidence. It accepts `workspace` or `changeset` scope and `all` or
`introduced` comparison. Missing or invalid callbacks fail evaluation; it
never treats a failed scan as clean. `manifest.py` renders an experimental
manifest with checksums for the interpreter, provider, rule pack, manifest
generator, and exact scanner binary.

To run the smoke tests with an absolute path to a pinned AST-grep binary:

```sh
AST_GREP_BIN=/absolute/path/to/ast-grep \
  python3 -m unittest discover -s contrib/asp-ast-grep -p 'test_*.py' -v
python3 contrib/asp-ast-grep/manifest.py /absolute/path/to/ast-grep
```

The scanner runs over untrusted source in provider-private scratch. Temporary
files and subprocess timeouts do not provide sandbox isolation; an outer host
must enforce its own process, filesystem, network, and resource policy. The
host must freeze the selected rule configuration outside an agent-editable
candidate and verify the returned configuration digest. For a cooperative
local workflow, a pre-edit hook can guard `.opcore.json`, while the host checks
its bytes again during evaluation. That hook is not a security boundary
against a hostile candidate.

For SCBench, this rule targets part of the benchmark's *verbosity* metric.
Structural erosion is a separate complexity-mass metric; Opcore's complexity
check, not AST-grep, is the direct intervention there. Any experiment must
report the benchmark's untouched evaluator output, functional checkpoints,
agent and checker time, tokens/cost, and intervention-triggered correction work.
Matching a rule that the benchmark scores is direct metric alignment, not
independent evidence of maintainability.
