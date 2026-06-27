---
name: testing
description: Write tests and debug systematically.
---

# Testing & Debugging Skill

## 🔴 CORE PHILOSOPHY

If the repo has test-law or runner-ownership docs, read them first. Tests discover bugs, not pass. Fix code, not tests.

**TEST LAYER SELECTION IS NON-NEGOTIABLE:**
- Default to unit/integration/contract tests
- **NEVER** use Playwright for backend, auth, routing, DB, workers, containers, preview lifecycle, WebSocket protocol, or service networking
- Use Playwright only when DOM/rendering/iframe/real user interaction is the contract

## Test-Driven Development (TDD)

### TDD Workflow

1. **Write failing test** - Describes desired behavior
2. **Write minimal code** - Makes test pass
3. **Refactor** - Improve code quality
4. **Verify** - Run test 10 times to ensure it's not luck

### Test Structure Pattern

```javascript
test("should do something", async ({ page }) => {
  // 1. SETUP - Create isolated test data
  const user = await createTestUser(page);
  await registerUser(page, user);
  await login(page, user);

  // 2. ACTION - Perform test action
  await page.click('button:has-text("Spawn Agent")');

  // 3. ASSERTION - Verify expected behavior
  await expect(page.locator("text=Agent spawned")).toBeVisible();

  // 4. CLEANUP (optional - only if needed)
});
```

### Test Isolation Rules

**ALWAYS create unique test data:**

```javascript
// ❌ WRONG - Hardcoded (fails on second run)
const user = { email: "test@example.com", password: "test" };

// ✅ CORRECT - Unique every run
const user = {
  email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  password: `Pass-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: `TestUser-${Date.now()}`,
};
```

**NEVER depend on:**
- Hardcoded demo users (alice@demo.com)
- Existing database state
- Seed scripts

### API Setup Over UI Clicking

```javascript
// ✅ PREFER - API calls or fixtures (fast, reliable)
const auth = await createApiAuth(page);
await page.request.post(`${env.baseURL}/api/resources`, {
  headers: auth.headers,
  data: buildFixture(),
});

// ❌ AVOID - UI clicking (slow, brittle)
await page.click('button:has-text("New Project")');
await page.fill('input[name="name"]', "Test Project");
await page.click('button:has-text("Create")');
```

## 🔴 THE DELETION TEST — Assertion Value (MOST IMPORTANT SECTION)

**A test is theatre when no realistic production bug could make it fail.** Before committing ANY test: mentally delete the implementation. If the test still passes, the test is WORTHLESS.

**The deletion test asks:** would deleting the implementation make this test fail? If not, the test is theatre.

**Regression tests from postmortems:** apply a **Contract-Restatement Gate** before writing the test. Restate the behavior without incident-only names, file paths, dates, or identifiers. The primary test should assert the general contract; incident breadcrumbs belong in comments or an optional secondary tripwire.

### Worthless vs Valuable Assertions

| Worthless (shape/wiring) | Why it's worthless | Valuable (behavioral) |
|---|---|---|
| `expect(result).toBeInstanceOf(X)` | Passes with empty stub | `expect(result.compute(input)).toBe(output)` |
| `expect(mock).toHaveBeenCalledWith(args)` | Verifies wiring | `expect(actualSideEffect).toBe(expected)` |
| `expect(config).toHaveProperty('key')` | Shape theater | Feed config to consumer, verify outcome |
| `expect(response.status).toBe(200)` (all mocked) | Mock returns 200 | Hit real handler with edge cases |
| `expect(factory(type)).toBeInstanceOf(Impl)` | Constructor dispatch | `factory(type).execute(input)` produces right output |
| `expect(true).toBe(true)` | Tautological — always passes | Delete entirely, assert real behavior |
| `expect(typeof X).toBe('function')` | TS compilation already proves this | Test what X does with real input |

### What is NOT Theatre (Prevent Overcorrection)

| Pattern | Why it's valid |
|---|---|
| `toBeDefined()` as guard before deeper assertions | Prevents cryptic errors on next line |
| `.rejects.toBeInstanceOf(Error)` | Tests error path — swallowed error would fail |
| `toBeInstanceOf` alongside behavioral assertions | Behavioral assertion is the proof; instanceof is supplementary |
| Cross-boundary shape checks | Shape IS the contract when consumer is external |
| `toHaveBeenCalledWith()` verifying computed values | Mock exposes what logic COMPUTED |

### Cross-Boundary Contract Tests (HIGHEST VALUE)

The most valuable tests verify that System A's output actually works when consumed by System B:

```javascript
// ❌ SHAPE: adapter config has right keys
expect(config.servers).toHaveProperty('code-intelligence');
expect(config.servers['code-intelligence'].command).toBe('node');

// ✅ CONTRACT: adapter config actually starts the MCP server
const config = adapter.generateMcpConfig();
const out = await dockerRun(image, `node -e "import('${config.serverPath}')"`)
// Proves the output WORKS, not just that it has the right shape
```

### Mock Tests That DO Work

Mocks are fine when they expose what business logic COMPUTED:

```javascript
// ✅ USEFUL - Verifies business logic via mock
expect(mockRuntime.getLastHealthCheckUrl()).toBe(`http://127.0.0.1:${port}/health`);
expect(mockProvisioner.getLastResourceName()).toBe(`job-${workspaceId}-${runId}`);
expect(mockProvisioner.getCalls('start')[0].args.command).toContain('--workspace');
```

**Mocks MUST implement:** `getCalls(method?)`, `getLastX()` convenience methods. Track ALL arguments.

### Testing Strategy

| Tier | What It Catches | Speed | When |
|---|---|---|---|
| Unit (behavioral assertions) | Logic bugs, edge cases | Fast | Every PR |
| Contract (cross-boundary) | Integration bugs, config drift | Medium | Every PR |
| Real Docker/integration | Environment bugs | Slow | Nightly |

## Systematic Debugging Methodology

### 6-Step Debugging Process

| Step | Action | Key Question |
|------|--------|--------------|
| 1. Reproduce | Run 10 times, document exact steps | Does it fail consistently? |
| 2. Isolate | Minimal reproduction (10 lines), remove Docker/network/DB | What's the MINIMAL failing setup? |
| 3. Understand | Read failing code, trace execution, verify assumptions | What ACTUALLY happens vs expected? |
| 4. Fix | Root cause only, document WHY | WHY did it fail? (not just WHAT) |
| 5. Verify | Run 10 times, test edge cases | Lucky once, or actually fixed? |
| 6. Prevent | Add test for this bug, update repo docs/skills/checks if needed | How to catch this early? |

### Log Investigation Pattern

❌ "Let me check the logs" → ✅ "HTTP 500 - checking the owning service logs for the stack trace, THEN reading failing code"

**ALWAYS:** WHICH logs → WHAT looking for → WHAT you'll do with it

### Debugging Anti-Patterns

| Anti-Pattern | Why It's Wrong | Correct Approach |
|--------------|----------------|------------------|
| Trial and error | Guessing wastes time | Check ACTUAL values first, trace why wrong |
| Blame cache | Cache is rarely the issue | Check headers, state flow, API responses |
| Hide with try-catch | Error still exists | Find WHY it throws, fix root cause |
| Add fallbacks | Masks real bug | Ask WHY value is undefined, fix source |

## Root Cause Analysis

| Principle | What To Do |
|-----------|------------|
| Ask WHY until bedrock | Network issue? WHY → Port conflict? WHY → Race condition? WHY → Keep digging |
| Isolate | 5-line reproduction > 10,000 lines. Remove Docker/network/DB. Change ONE thing. |
| No shortcuts | Stop guessing. No workarounds. "Probably works" → RUN IT. |
| Real environment | Test in Docker if prod uses Docker. Real data. Test failure modes. 10x runs. |

## Test Commands Reference

### Unit Tests

Use the owning unit-test command for the repo and run the narrowest possible slice first.

```bash
npm test -- path/to/spec.test.ts
pnpm test path/to/spec.test.ts
cargo test failing_case_name
pytest tests/unit/test_module.py -k failing_case
```

### Integration / Contract Tests

Run the smallest real cross-boundary check that can prove the behavior.

```bash
npm run test:integration -- path/to/spec.test.ts
pnpm test:contract
pytest tests/integration/test_api.py -k failing_case
cargo test --test api_contract
```

### Playwright Tests (Browser Contracts Only)

```bash
# USE ONLY when the browser is required to observe the bug.
npx playwright test path/to/spec.ts
npx playwright test --headed
npx playwright test --project=chromium
```

**If the browser is not required, STOP and build the lower-layer test instead.**

## Tooling Cheatsheet

**JavaScript/TypeScript:**
- DevTools breakpoints, `console.table`, `performance.mark`
- VS Code launch configs

**Node:**
- `--inspect`, `--trace-warnings`, `--trace-deprecation`
- `clinic flame` for profiling

**Database:**
- use the repo's canonical query tool or local client (`psql`, `sqlite3`, ORM shell, seeded fixtures)
- verify the exact rows or records involved in the failure rather than guessing from app behavior

**Docker:**
- `docker compose logs -f <service>`
- `docker ps -a`
- `docker inspect <container-id>`
- `docker stats`

**Git:**
- `git bisect` - binary search for regressions
- `git log --oneline --since="2 days ago"`

## Red Flags (You're Guessing)

- Adding retries/timeouts "just because"
- Silencing errors instead of finding source
- Dismissing areas with "it can't be that"
- Skipping reproduction or minimal case
- Not diffing working vs broken paths

## ALWAYS - Not Suggestions, Requirements

- **ALWAYS find root cause before fixes** - No band-aids
- **ALWAYS isolate to minimal reproduction**
- **ALWAYS verify in realistic environment**
- **ALWAYS create isolated test data** - Unique emails
- **ALWAYS investigate test failures** - They found bugs
- **ALWAYS update repo-local test docs/checks when the failure exposes a reusable rule**

## NEVER - These Will Break You

- **NEVER accept "it doesn't work" as an answer**
- **NEVER apply fixes without understanding root cause**
- **NEVER skip verification**
- **NEVER weaken tests to make them pass**
- **NEVER depend on demo users**
- **NEVER modify system code to make tests pass**
- **NEVER use `.skip()` or comment out tests**

## PREFER - Better Ways Exist

- **PREFER understanding over trial-and-error**
- **PREFER minimal reproduction** - 10 lines beats 1000
- **PREFER root cause fixes over workarounds**
- **PREFER API calls for test setup**
- **PREFER unique identifiers** - `user-${Date.now()}`
- **PREFER semantic assertions** - `toBeVisible()` beats `toBeTruthy()`

## Regression Prevention

After fixing a bug:

1. **Add targeted test** (unit/integration/E2E) for root cause
2. **Add logs/metrics/traces** around fault domain
3. **Document the fix** in issue/PR for future recall
4. **Update repo-local docs/skills/checks** with reusable lessons learned
5. **Delete workarounds** added during debugging
