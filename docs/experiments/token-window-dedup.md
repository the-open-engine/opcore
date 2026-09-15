# Token-Window Deduplication Experiment

Date: 2026-08-05

This experiment measures an exact sub-block duplication candidate path without
changing production behavior. The benchmark is `benches/token_windows.rs`.

## Question

Can Opcore recover the legacy detector's arbitrary copied-block coverage
without materially harming Sense latency or memory bounds?

## Prototype

The benchmark parses generated TypeScript through the pinned Oxc lexer and
interns exact token identities, including Node inter-token line-break state. It
compares three request-local indexes:

1. Every exact 48-token window, indexed by two rolling 64-bit hashes and
   verified by exact token comparison.
2. Every exact 48-token window hashed independently with SHA-256.
3. Winnowing: rolling 32-token k-grams, a 17-k-gram rightmost-minimum span, and
   SHA-256 only for selected anchors.

The winnowing parameters guarantee that every exact run of at least 48 tokens
contains a shared selected anchor. A deterministic 128-case offset check runs
before measurement. All record collection stops at 200,000 entries and reports
truncation.

Measurements used the release profile on Linux x86-64 with 16 logical CPUs.
Each rolling result is the median and p95 of 15 iterations; SHA-per-window uses
five iterations. Peak RSS was measured by `/usr/bin/time -v` around the already
built benchmark, excluding compilation.

One unpinned repeat on the shared host reached 104 ms median and 200 ms p95 for
the 10,000-file winnowed case while smaller cases remained stable. Two complete
repeats pinned to one CPU measured 82.8-83.4 ms median and 83.3-85.2 ms p95;
the duplicate-heavy case measured 6.16-6.21 ms median. The table reports the
first direct run, and these timings are experimental evidence rather than a new
shared-runner pass/fail threshold.

## Results

| Corpus | Lexer tokens | All rolling median / p95 | Winnowed SHA median / p95 | SHA each median |
|---|---:|---:|---:|---:|
| 100 unique files | 30,800 | 0.74 / 0.86 ms | 0.94 / 1.02 ms | 5.81 ms |
| 320 unique files | 98,560 | 2.57 / 2.99 ms | 3.04 / 3.12 ms | 18.89 ms |
| 800 unique files | 246,400 | 6.56 / 7.70 ms | 7.69 / 7.77 ms | 45.70 ms |
| 800 duplicate-heavy files | 246,400 | 10.48 / 10.67 ms | 6.17 / 6.27 ms | 49.68 ms |
| 10,000 unique files | 3,080,000 | 6.55 / 6.65 ms, truncated | 83.61 / 84.98 ms, truncated | 45.75 ms, truncated |

At 800 files, indexing every window reached the 200,000-record cap and used
4.8 MB for one view or 9.6 MB for before plus after. Winnowing retained about
23,900 anchors and used 0.57 MB for one view. At 10,000 files, winnowing selected
298,563 possible anchors, retained the bounded 200,000 records, and used 4.8 MB
for those candidate records. The complete benchmark process peaked at 87,728
KiB RSS; its retained exact token IDs accounted for 12.32 MB at that scale.

The duplicate-heavy corpus is intentionally adversarial. Every-window indexing
performed 197,441 exact comparisons and still completed in 10.67 ms p95.
Winnowing reduced this to 23,171 comparisons and 6.27 ms p95. No candidate-hash
collision occurred.

The explicit production Sense stress suite was also run after integration. On
the same 16-CPU host, its unoptimized test binary spent 14.96 ms in deduplication
for the median clean 10,000-file view, 59.60 ms for one changed file, and
59.69 ms for 1,001 changed paths. Eight simultaneous clean worktrees each spent
15.97-25.60 ms in deduplication, and the largest measured process stayed below
67,452 KiB RSS. These shared-host timings are a diagnostic snapshot, not a
microsecond gate; the suite's boundedness and deterministic-result assertions
remain authoritative.

## Interpretation

CPU cost is not the main blocker. A bounded all-window rolling index is fast,
but it exhausts the request budget too readily and emits excessive overlapping
candidates: one repeated generated function produced 258 exact window classes.
Winnowing reduced that to 29 anchors while retaining the 48-token detection
guarantee and cutting ordinary record memory by about 88%.

The 10,000-file winnowing cost is cold extraction work over all 3.08 million
tokens. Production extraction now emits selected path-independent fingerprints
during the existing parser pass and reuses them from the fact cache; warm
request comparison sorts and groups only retained fingerprints.

## Recommendation

The production implementation adopts the winnowed design:

- 32-token exact k-grams;
- 17-k-gram rightmost-minimum winnowing span;
- dual rolling anchor hashes followed by exact normalized-token confirmation;
- 4,096 selected anchors per file and 200,000 per request;
- 4,000,000 exact token comparisons per request;
- request-local maximal-region merging with bounded occurrence samples and no
  occurrence-pair expansion;
- introduced-only comparison using existing exact path continuity.

Fact ABI v14 carries compact exact token spans so hashes are never authoritative.
Any extraction, anchor, decode, or comparison bound yields incomplete coverage.
Node, Python, and Rust fixtures cover partial blocks, the exact 48-token
threshold, 128 match offsets, forced hash collisions, parser failure, callable
and whole-file cascade suppression, multi-copy class merging, and repetitive
streams.
