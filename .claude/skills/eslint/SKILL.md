---
name: eslint
description: Create and enforce ESLint rules.
---

# ESLint Rule Engineering

**MISSION: Turn every class of bug into a mechanical gate. Error messages ARE the documentation. ERRORS OVER WARNINGS. ALWAYS.**

## BEFORE WRITING A NEW RULE

**STOP. Check these FIRST:**

| Check | WHY: consequence if skipped |
|-------|----------------------------|
| Can an EXISTING rule be GENERALIZED? Grep `eslint-local-rules/` | Duplicate rules = maintenance hell. 70+ exist. Duplication is a bug. |
| Can a BUILT-IN rule handle it? (`no-restricted-imports`, `no-restricted-syntax`, `no-restricted-properties`) | Built-in rules are battle-tested. Custom rules need maintenance. |
| Can the TYPE SYSTEM catch it? | Types > lint > docs. Compile-time is always better than lint-time. |
| Is this a CLASS of bug or a one-off? | One-off = fix the code. Only classes deserve rules. |

## RULE DESIGN PHILOSOPHY

### Broad Over Narrow — ALWAYS

```
BAD:  "no-k8s-import-in-routes"     (too narrow — what about ec2? docker?)
GOOD: "no-executor-implementation-coupling" (catches ALL concrete executor imports)

BAD:  "no-db-client-in-tests"         (too narrow — what about services?)
GOOD: "no-direct-db-client-construction" (catches ALL direct instantiation)

BAD:  "no-docker-string-in-lifecycle" (too narrow — what about "k8s"? "ec2"?)
GOOD: "no-environment-specific-code"  (catches ALL env-specific branching, configurable)
```

**The test:** Would adding a new provider/env/feature require a NEW rule? If yes, your rule is too narrow. GENERALIZE.

### Configurable Over Hardcoded

Rules MUST accept options for `allowedFiles`, `allowComment`, `forbiddenTerms` etc. so eslint.config.js can tune scope without touching rule code. See `no-environment-specific-code.js` as the gold standard.

```javascript
// GOOD: Configurable rule with schema
schema: [{
  type: "object",
  properties: {
    allowedFiles: { type: "array", items: { type: "string" } },
    allowComment: { type: "string" },
    forbiddenTerms: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
}],
```

### Error Messages — NON-NEGOTIABLE FORMAT

Every error message MUST contain ALL THREE:

1. **WHAT is forbidden** (the violation)
2. **WHY it's forbidden** (the consequence — production incident, architectural violation, data loss)
3. **HOW to fix it** (the exact alternative)

```javascript
// BAD: Useless message
"Don't use process.env directly"

// GOOD: Actionable, non-negotiable, explains consequence
"FORBIDDEN: Direct process.env access. This bypasses runtime validation — " +
"missing vars silently return undefined instead of failing at startup. " +
"Fix: Use getEnv().VAR_NAME from config/env-validation.ts"
```

**Error messages are read by agents and juniors at 2am. They must be COMPLETE. No "see docs." No "consider using." TELL THEM EXACTLY WHAT TO DO.**

## RULE IMPLEMENTATION PATTERN

### File Structure

```
eslint-local-rules/
  index.js                          # Registry — ALL rules exported here
  path-match.js                     # Shared glob matcher (matchesAny)
  my-new-rule.js                    # Rule implementation
  my-new-rule.test.js               # REQUIRED: test with valid/invalid cases
```

### Rule Template

**Gold standard reference:** Read `eslint-local-rules/no-environment-specific-code.js` — configurable, broad, actionable messages.

| Required Element | Pattern |
|-----------------|---------|
| `meta.type` | ALWAYS `"problem"` (WHY: `"suggestion"` = ignored) |
| `meta.messages` | `"FORBIDDEN: {{what}}. WHY: {{consequence}}. Fix: {{alternative}}."` |
| `meta.schema` | Object with `allowedFiles`, `allowComment`, domain-specific options |
| `create()` first line | `if (matchesAny(filename, allowedFiles)) return {};` (fast skip) |
| `hasAllowComment()` | Check same-line/prev-line comment for escape hatch (logging ONLY) |
| AST visitors | Specific node types (`CallExpression`, `Literal`, `MemberExpression`) — NOT `Program` walk |

### Registration in index.js

```javascript
// In eslint-local-rules/index.js — add ONE line:
"my-new-rule": require("./my-new-rule.js"),
```

### Configuration in eslint.config.js

```javascript
// In server/eslint.config.js — add to rules object:
"local/my-new-rule": ["error", {
  allowedFiles: ["**/implementations/**", "**/di/**"],
  allowComment: "rule-ok",
}],

// For file-scoped rules, add override block:
{
  files: ["server/src/routes/**/*.ts"],
  rules: {
    "local/my-new-rule": ["error", { /* route-specific config */ }],
  },
},
```

## VERIFICATION — PROVE IT WORKS BEFORE COMMITTING

### Step 1: Ad-hoc verify (OWNING LAYER)

```bash
# Test against a file that SHOULD trigger the rule
npx eslint --no-eslintrc -c <(echo '
import localRules from "./eslint-local-rules/index.js";
export default [{ plugins: { local: localRules }, rules: { "local/my-rule": "error" }, files: ["**/*.ts"] }];
') server/path/to/known-violation.ts

# Test against a file that should NOT trigger
npx eslint --rulesdir eslint-local-rules server/path/to/clean-file.ts
```

### Step 2: Write test cases

```javascript
// eslint-local-rules/my-new-rule.test.js
const { RuleTester } = require("eslint");
const rule = require("./my-new-rule.js");

const tester = new RuleTester({ parserOptions: { ecmaVersion: 2022, sourceType: "module" } });

tester.run("my-new-rule", rule, {
  valid: [
    // Cases that MUST pass — include edge cases and allowed patterns
    { code: 'import { getEnv } from "./config/env-validation";', },
    { code: 'process.env.NODE_ENV', options: [{ allowedFiles: ["**/test/**"] }],
      filename: "test/foo.ts" },
  ],
  invalid: [
    // Cases that MUST fail — test EVERY messageId
    {
      code: 'const x = process.env.MY_VAR;',
      errors: [{ messageId: "forbidden" }],
    },
    // Test that allowComment suppresses
    // Test that allowedFiles bypasses
    // Test edge cases (destructuring, bracket access, etc.)
  ],
});
```

### Step 3: Run the test

```bash
node eslint-local-rules/my-new-rule.test.js
```

### Step 4: Full lint to catch existing violations

```bash
cd server && npx eslint --rule '{"local/my-new-rule": "error"}' 'src/**/*.ts' 'services/**/*.ts'
```

**If existing violations exist: FIX THEM ALL before committing the rule. The rule and the fixes ship together.**

## ANTI-PATTERNS IN RULE DESIGN

| Anti-Pattern | Why It's Wrong | Fix |
|-------------|---------------|-----|
| `type: "suggestion"` | Suggestions are IGNORED. This is enforcement. | ALWAYS `type: "problem"` |
| Warning level | Warnings are noise. They train people to ignore lint. | ALWAYS `"error"` |
| Message says "consider" or "should" | Passive language = optional = ignored | "FORBIDDEN" / "REJECTED" / "Fix:" |
| No `allowedFiles` option | Rule can't be scoped = disabled entirely when one file needs exception | Add schema with `allowedFiles` |
| Hardcoded file paths in rule | Paths change, rule breaks silently | Use `allowedFiles` in config |
| No test file | Untested rule = broken rule waiting to happen | ALWAYS ship `.test.js` |
| Catches one specific term | Too narrow — won't catch the next variant | Generalize to the CLASS |
| No WHY in error message | Developer doesn't understand, works around instead of fixing | Include consequence + postmortem reference |

## SUPPRESSION COMMENT CONVENTIONS

When `allowedFiles` scoping is too broad but code is correct and the rule is a false positive, use inline suppression comments. NEVER suppress just to make lint pass — suppression is for genuine false positives only.

| Comment | Rule(s) | When Legitimate |
|---------|---------|----------------|
| `// env-ok: <reason>` | `ban-process-env`, `require-validated-env-vars`, `no-process-env-in-socket` | CLI check scripts in `checks/` that are standalone executables, not server application code. They need raw `process.env` before validation infrastructure is loaded. |
| `// port-ok: <reason>` | `no-hardcoded-ports` | Test fixtures, constants files, or protocol definitions where the port IS the contract. |
| `// promise-ok: <reason>` | `no-unbounded-promise-all-map` | Bounded arrays where cardinality is provably small (e.g. `worktrees.map` max 10). |

**`checks/` directory pattern:** NamedCheck extension files are CLI scripts that run as standalone executables. `ban-process-env` flags them because they use `process.env` directly — this is correct for CLI scripts that run before server validation infrastructure loads. Use `// env-ok: CLI check script, not server application code` on the specific line.

## EXISTING RULE INVENTORY (Check Before Creating)

| Category | Rules | Generalizable? |
|----------|-------|----------------|
| **Env/infra boundary** | `no-environment-specific-code`, `ban-process-env`, `no-runtime-mode-env-checks`, `no-self-hosted-checks`, `require-validated-env-vars`, `no-forbidden-abstraction-terms` | Extend `no-forbidden-abstraction-terms` for new leaked terms |
| **DI/factory boundary** | `no-direct-service-instantiation`, `no-module-scope-instantiation`, `no-di-circular-call`, `no-direct-factory-bypass`, `no-service-locator-defaults`, `no-exported-service-singleton` | Extend `no-direct-service-instantiation` allowedFiles |
| **Executor boundary** | `no-executor-implementation-coupling`, `no-detect-worker-type`, `no-executor-capability-flags`, `no-executor-env-introspection` | These are comprehensive — rarely need new ones |
| **Provider boundary** | `no-provider-name-check`, `no-provider-implementation-leak`, `no-direct-guardrail-branching` | Extend `no-provider-implementation-leak` for new providers |
| **DB/ORM** | `no-direct-db-client-construction`, `require-deterministic-query-order`, `require-integrity-gates-for-multi-step-reads`, `require-transaction-for-multi-write` | Prefer broad invariants over entity-specific rules |
| **API contract** | `require-typed-response`, `require-contract-registration`, `no-inline-api-body` | Extend for new route patterns |
| **Socket/transport** | `require-validated-socket-emit`, `ban-direct-emit-validated`, `no-unknown-socket-emit-data` | Well-covered |
| **Security** | `no-adhoc-commands`, `no-dangerous-spawn`, `no-dangerous-fallbacks`, `no-metadata-spread`, `require-boundary-validation` | Extend for new injection vectors |
| **Code structure** | `no-runtime-logic-in-types-modules`, `registration-module-delegation-only`, `no-multi-subcommand-workflows`, `no-legacy-labeling` | Extend for new SRP violations |
| **Client** | `no-hardcoded-colors`, `no-unpaired-theme-class`, `react-no-unstable-hook-deps`, `react-no-derived-state-from-props`, `no-direct-auth-token-storage`, `no-empty-token-setter`, `no-direct-local-storage`, `require-auth-transition-reset` | Well-covered |
| **Testing** | `require-dual-module-mock` | Extend for new mock patterns |
| **Robustness** | `require-error-context`, `no-empty-catch`, `no-hardcoded-ports`, `no-unsafe-type-assertion`, `no-dynamic-import-concat`, `no-static-optional-import`, `no-raw-network-without-timeout`, `no-unbounded-promise-all-map`, `zod-record-two-args` | Keep them in a shared robustness lint pack when multiple repos need them |

## SHARED UTILITIES

| File | Exports | Use For |
|------|---------|---------|
| `path-match.js` | `matchesAny(filename, globs)` | File path allowlisting in ALL rules |

## PERFORMANCE

- Rules run on EVERY file during lint. Keep visitors minimal.
- Use `matchesAny()` early return for `allowedFiles` (skip entire file).
- Avoid `Program` visitor + walking full AST — use specific node visitors.
- Avoid regex in hot paths — use `Set.has()` for term matching.

## WORKFLOW SUMMARY

1. **Bug found** → Is this a CLASS of bug?
2. **Check existing rules** → Can one be EXTENDED?
3. **If new rule needed** → Generalize to the broadest CLASS
4. **Write rule** → `type: "problem"`, configurable schema, ACTIONABLE error messages
5. **Write test** → Valid AND invalid cases, all messageIds covered
6. **Ad-hoc verify** → Run against known violations AND clean files
7. **Fix ALL existing violations** → Rule + fixes ship together
8. **Register** → `index.js` + `eslint.config.js`
9. **Commit** → Pre-commit runs full lint to verify
