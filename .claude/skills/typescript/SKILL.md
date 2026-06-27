---
name: typescript
description: Write strict TS/React/Node code.
---

# TypeScript Development Guidelines

## TypeScript Fundamentals

- ALWAYS use strict TypeScript - no `any` unless absolutely necessary
- ALWAYS define explicit return types for functions
- ALWAYS use interfaces for object shapes, types for unions/primitives
- PREFER `unknown` over `any` when type is truly unknown
- USE type guards for runtime type narrowing

### Nullable Types

**DO NOT USE `?` or `| null | undefined` UNLESS ABSOLUTELY NECESSARY**

- Adding `?` to avoid type error = WRONG. Fix root cause instead.
- Required config, function params = non-nullable
- Only nullable: DB nulls, optional API fields, optional user input

### Strict Mode: Optional Chaining vs Explicit Checks

**When `strict: true` is enabled, choose the right pattern for each case:**

```typescript
// ❌ WRONG - Optional chaining creates incompatible types
const userId = req.user?.userId  // Type: string | undefined
if (!userId || !teamId) { ... }  // Works but userId still typed as possibly undefined

// ✅ PATTERN 1: Explicit null check (PREFERRED)
if (!req.user || !req.user.userId) {
  return res.status(401).json({ error: 'Unauthorized' })
}
const userId = req.user.userId  // Type: string (narrowed by check)

// ✅ PATTERN 2: Logical AND (when assigning to variable for null check)
const userId = req.user && req.user.userId
if (!userId) { return res.status(401) }

// ✅ PATTERN 3: Optional chaining (when genuinely optional)
const optionalField = user?.preferences?.theme  // OK if undefined is valid
```

**Removing Non-Null Assertions (`!`)**

```typescript
// ❌ FORBIDDEN - Non-null assertion bypasses safety
const agentId = req.params["id"]!;
const user = await findUser(userId!);

// ✅ CORRECT - Let TypeScript infer from checks
const agentId = req.params["id"]; // Already string, no ! needed
if (!req.user?.userId) {
  return res.status(401);
}
const user = await findUser(req.user.userId); // Safe after check
```

**When to use each:**

- **Explicit checks**: Authenticated middleware values (`req.user`, `req.params.id`)
- **Optional chaining**: Optional API fields, UI preferences, nullable DB columns
- **Logical AND**: Rare - only when explicit check is unnecessarily verbose

(LESSON LEARNED 2025-12-08)

## React Patterns (Frontend)

- USE functional components with hooks (no class components)
- PREFER named exports over default exports
- USE TypeScript generics for reusable components
- DEFINE prop interfaces explicitly: `interface Props { ... }`
- USE `React.FC<Props>` sparingly - prefer explicit function signatures

## Node.js/Express (Backend)

- USE ESM modules (`import`/`export`), not CommonJS
- DEFINE request/response types for API endpoints
- USE middleware typing: `RequestHandler`, `ErrorRequestHandler`
- ALWAYS handle async errors with try/catch or error middleware

## Layering Patterns

- Frontend: keep UI types close to the UI code that owns them
- Backend: keep handler/service types close to the server layer that owns them
- Shared types: define them in the consuming package unless they are a real cross-boundary contract
- API types: derive from validated contracts or generated schema types where applicable

## Development Workflow

### Auto-Reload (Docker Development)

**NEVER manually restart containers for TypeScript code changes!**

- ✅ **Frontend (.tsx, .ts, .css)** → Vite HMR picks up instantly (1-2 seconds)
- ✅ **Backend (.ts files)** → Nodemon + esbuild auto-rebuild (2-3 seconds)
- ✅ **Config files** → Usually picked up by HMR/nodemon

**Just save and wait 2-3 seconds.** Check logs to see reload:

```bash
docker compose logs -f backend   # See nodemon rebuild
docker compose logs -f frontend  # See Vite HMR
```

### When Restart IS Required

Only restart for these changes:

- ❌ `package.json` → New dependencies
- ❌ `.env` → Environment variables
- ❌ `Dockerfile` → Container config
- ❌ `docker-compose.yml` → Service config

```bash
# After package.json changes
docker compose build backend && docker compose up -d

# After .env changes
docker compose restart backend
```

## Type Checking Workflow

**Run type checking WHEN DONE with implementation (not after every single edit):**

```bash
# Frontend
cd client && npm run type-check

# Backend
cd server && npm run type-check
```

**When to type check:**

- ✅ After completing a feature or fix
- ✅ Before committing changes
- ✅ After refactoring
- ❌ NOT after every single file edit (too slow)

**IF TYPE ERRORS:**

- ❌ DO NOT ignore or defer
- ❌ DO NOT use `@ts-ignore` or `@ts-expect-error` to suppress
- ✅ FIX the actual type issue IMMEDIATELY before moving on

**Type checking catches:**

- Missing imports
- Wrong function signatures
- Incorrect prop types
- Null/undefined access bugs
- Breaking API contract changes

## 🔴 MANDATORY: Test Verification After Changes

**Workflow:** Type check → Identify relevant tests → Run them → Fix failures → THEN done

**Find tests:** Tests mirror src/ structure. Changed `server/src/routes/agents.ts` → check `tests/unit/server/routes/agents*.test.ts`

```bash
grep -r "FunctionName" tests/ --include="*.test.ts" -l   # By function
cd tests && npx jest --testPathPattern="agents"          # Run matching
```

**If tests fail:** YOUR CODE IS WRONG. Fix it. Never skip "because it's small".

## Common Mistakes to Avoid

- Don't use `as` type assertions to bypass type errors - fix the actual type
- Don't ignore TypeScript errors with `@ts-ignore` - fix the root cause
- Don't mix ESM and CommonJS in the same codebase
- Don't use `Function` type - use specific function signatures
- Don't restart containers for code changes - trust nodemon/HMR
- Don't skip type checking after edits - run `npm run typecheck`

## 🚨 Debugging Anti-Patterns

### NEVER Blame Cached State for Frontend Issues

**If you think a frontend bug is caused by "cached state" - YOU ARE WRONG and overlooking the actual issue!**

- ❌ "Must be browser cache" - NO, there's a real bug you're missing
- ❌ "Clear localStorage" - NO, fix the actual state management issue
- ❌ "Hard refresh will fix it" - NO, that's hiding a symptom, not fixing the cause
- ❌ "React state is stale" - NO, you have a logic error in your component

**Cached state is RARELY the actual problem. If you suspect it:**

1. Stop and re-examine your assumptions
2. Check network requests (DevTools Network tab)
3. Check component props and state flow
4. Check API response data
5. Look for race conditions or async timing issues
6. Check your actual code logic - the bug is almost certainly there

**Real causes when you blame cache:**

- API returning old/wrong data
- Component not re-rendering when props change
- State update logic is wrong
- Race condition between async operations
- WebSocket/polling not updating state correctly
- Missing dependency in useEffect

**Bottom line: "It's cached state" is almost always a red herring. Find the real bug.**

---

## 🔴 ESLint Rules (Template Enforcement)

**MECHANICALLY ENFORCED** - Violations FAIL builds. Error messages tell you WHY and HOW to fix.

| Category | Rules | Key Fix |
|----------|-------|---------|
| **Security** | `react/no-danger`, `jsx-no-target-blank`, secrets detection | Use React auto-escaping, add `rel="noopener"`, use env vars |
| **Memory Leaks** | `require-effect-cleanup`, `require-abort-controller`, `no-event-listener-leak` | ALWAYS return cleanup function in useEffect |
| **Error Handling** | `no-empty`, `no-floating-promises`, `promise/catch-or-return` | NEVER empty catch, ALWAYS await/catch promises |
| **Accessibility** | `alt-text`, `click-events-have-key-events`, `label-has-associated-control` | Images need alt, clickables need keyboard, labels need htmlFor |
| **Magic Values** | `no-magic-numbers`, hardcoded URLs/timeouts | Extract to named constants, use env vars |
| **React Perf** | `no-array-index-key`, `no-unstable-nested-components`, `jsx-key` | Use stable IDs, define components outside render |
| **Type Safety** | `no-explicit-any`, `ban-ts-comment`, `explicit-function-return-type` | Use `unknown`, fix types properly, add return types |
| **Testing** | `no-focused-tests`, `no-disabled-tests`, `expect-expect` | No `.only()/.skip()` committed, tests need assertions |
| **CSS** | `declaration-no-important`, `forbid-component-props` (style) | Use classes, no inline styles |
| **Complexity** | `complexity` (max 12), `max-depth` (4), `max-lines-per-function` (150) | Extract functions, reduce nesting |

**54 rules total.** Error messages tell you exactly what's wrong and how to fix it.
