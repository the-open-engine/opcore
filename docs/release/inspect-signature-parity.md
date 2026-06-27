# Inspect Signature Parity Evidence

Issue: #101

Status: `opcore inspect signature` is implemented as read-only inspect-owned language-service evidence after mandatory fresh GraphProvider status. This does not retire CIX, change ACE guidance, or make ASP host decisions.

## Field Mapping

| CIX `sig` field | Opcore field |
|-----------------|---------------|
| `name` | `inspectResult.signatures[].symbol.name` and `signature` text |
| `kind` | `inspectResult.signatures[].kind` |
| `file` | `inspectResult.signatures[].file` |
| `line` | `inspectResult.signatures[].line` |
| `isExported` | `inspectResult.signatures[].exported` |
| `isAsync` | `inspectResult.signatures[].async` |
| `typeParameters` | `inspectResult.signatures[].typeParameters` |
| `parameters` | `inspectResult.signatures[].parameters` |
| `returnType` | `inspectResult.signatures[].returnType` |
| not present | `providerStatus`, `target`, `span`, `symbol.id`, `evidence.graphNodeIds`, `evidence.resolver`, `overloadIndex` |

## Commands Run

```sh
npm run setup:tools
```

Output:

```text
current tool wrappers ready at /Users/tom/.zeroshot/worktrees/cobalt-falcon-81/.ace/runtime/bin
```

```sh
./.ace/runtime/bin/cix sig packages/fixtures/inspect-symbol-parity/src/models.ts formatGreeting --line 20 --json
```

Output:

```json
{
  "success": true,
  "signatures": [
    {
      "name": "formatGreeting",
      "kind": "function",
      "file": "src/models.ts",
      "line": 20,
      "isExported": true,
      "isAsync": false,
      "typeParameters": [],
      "parameters": [
        {
          "name": "message",
          "type": "GreetingMessage",
          "optional": false
        }
      ],
      "returnType": "string"
    }
  ],
  "timing": "141ms"
}
```

```sh
node packages/cli/dist/index.js graph build --repo packages/fixtures/inspect-symbol-parity --json
node packages/cli/dist/index.js inspect signature src/models.ts formatGreeting --line 20 --repo packages/fixtures/inspect-symbol-parity --json
```

Opcore output excerpt:

```json
{
  "owner": "inspect",
  "status": "ok",
  "providerStatus": {
    "state": "available"
  },
  "inspectResult": {
    "route": "signature",
    "status": "ok",
    "target": {
      "kind": "file_symbol",
      "path": "src/models.ts",
      "symbolName": "formatGreeting",
      "line": 20,
      "nodeId": "function:src/models.ts#formatGreeting"
    },
    "signatures": [
      {
        "file": "src/models.ts",
        "line": 20,
        "column": 1,
        "signature": "formatGreeting(message: GreetingMessage): string",
        "kind": "function",
        "parameters": [
          {
            "name": "message",
            "type": "GreetingMessage",
            "optional": false
          }
        ],
        "typeParameters": [],
        "exported": true,
        "async": false,
        "returnType": "string",
        "symbol": {
          "id": "function:src/models.ts#formatGreeting",
          "name": "formatGreeting",
          "kind": "Function"
        },
        "evidence": {
          "graphNodeIds": [
            "function:src/models.ts#formatGreeting"
          ],
          "resolver": "language_service"
        }
      }
    ]
  }
}
```

Overload comparison:

```sh
./.ace/runtime/bin/cix sig packages/fixtures/inspect-symbol-parity/src/overloads.ts describeGreeting --line 3 --json
```

Output:

```json
{
  "success": false,
  "message": "No signatures found for \"describeGreeting\""
}
```

```sh
node packages/cli/dist/index.js inspect signature src/overloads.ts describeGreeting --line 3 --repo packages/fixtures/inspect-symbol-parity --json
```

Opcore returns two signatures with `overloadIndex` `0` and `1`:

```json
[
  {
    "signature": "describeGreeting(model: GreetingModel): string",
    "overloadIndex": 0
  },
  {
    "signature": "describeGreeting(message: GreetingMessage): string",
    "overloadIndex": 1
  }
]
```

Retained gap: `opcore inspect implementations` remains typed unsupported. CIX stays as the retained guardrail until the implementations parity issue lands and #17/#4 evidence is updated.
