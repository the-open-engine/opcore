---
adr: 1
title: Base on JSON-RPC 2.0
status: accepted
date: 2026-06-16
---

# 1. Base on JSON-RPC 2.0

## Context

The existing tools (`rox`, `crg`, `cix`, tsserver) each reinvented NDJSON-over-Unix-socket
request/response with slightly different framing. We need one wire for the inner seam, and we want
server-pushed events (watch diagnostics, skew) and request multiplexing.

## Decision

Use **JSON-RPC 2.0**, newline-delimited. It is the same family as LSP/MCP/BSP, gives us
request/response + notifications + cancellation + error objects with codes, and is a tiny step from
the NDJSON the tools already speak. stdio is the conformance floor; Unix socket is an advertised
capability for warm shared servers.

## Consequences

- Implementers already know the shape; many robustness tools ship JSON-RPC/LSP servers already.
- We get notifications for free (push diagnostics, progress) and request ids for multiplexing.
- We are *not* adopting LSP's method set or document model — see [ADR 0002](./0002-lsp-vocabulary-not-wire.md).
