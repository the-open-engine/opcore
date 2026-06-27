# Demo

`opcore try` creates local sample repositories and runs the launch loop. It does not publish packages, docs, sites, telemetry, or announcements.

```text
Coverage:
  scenarios=5 files=13 validation=9 unsupported=1
Findings:
  coverage.unsupported_stacks: count=1 delta=0
  python.source_hygiene: count=1 delta=0
  python.syntax_errors: count=1 delta=0
  rust.source_hygiene: count=8 delta=0
  typescript.type_errors: count=2 delta=0
Loop:
  opcore --repo <sample>
  opcore init --repo <sample> --approve
  opcore check --changed --checks typescript.syntax,typescript.types,rust.source-hygiene,rust.file-length,python.syntax,python.source-hygiene --json
  opcore measure --repo <sample>
Sandbox:
  <local temp directory>
  generated locally; published=false
```

The JSON form returns `opcoreTry.published:false`, five scenario ids, command summaries, and named signals. The demo is generated on the local machine and keeps unsupported files visible instead of claiming day-one coverage for them.
