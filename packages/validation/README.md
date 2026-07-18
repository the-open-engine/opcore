# @the-open-engine/opcore-validation

Opcore validation runner package for scopes, overlays, checks, and command adapters.

Hypothetical graph-backed checks use one disposable exact-state graph session per `ValidationFileView`. Introduced reporting owns separate before/after sessions, shares each session across checks, fails closed on exact-state provider errors, and rejects incomplete visible-file universes.
