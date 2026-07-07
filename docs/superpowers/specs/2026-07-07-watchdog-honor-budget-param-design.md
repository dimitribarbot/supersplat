# Watchdog should honor `?budget=` — design

## Problem

The exported portal viewer's ready-gate watchdog (`src/viewer-companion/portals.ts:874`) installs a
fallback engine splat budget when `firstFrame` never fires:

```js
if (gs && !gs.splatBudget) {
  gs.splatBudget = (IS_MOBILE ? 2 : 4) * 1000000;
}
```

The stock supersplat-viewer applies an explicit `?budget=<n>` URL override **only inside
`applyPerfSettings`** (`splatBudget = budget() * 1000000`, where `budget()` returns `config.budget`
when `> 0`). `applyPerfSettings` runs on the ready/`firstFrame` path. So when `firstFrame` never
fires (slow network / engine bug #8998 residue), `applyPerfSettings` never runs, `splatBudget`
stays `0`, and the watchdog's hardcoded default **silently overrides the user's `?budget=`** —
exactly the slow-network case where a user is most likely to have raised it.

## Fix

Make the watchdog fallback honor `?budget=<n>` when present and valid, else keep the current
`2M`/`4M` default.

### 1. Pure parser in `src/portal-preload.ts`

Add and export a self-contained (stringifiable) helper:

```ts
// Parse the viewer's ?budget=<n> URL override into a splat count, matching the
// stock viewer's semantics (Number(param) * 1_000_000; used only when > 0).
// Returns 0 when absent/invalid so callers fall back to their own default.
// String-only, no regex — this is stringified into the companion template
// literal where character-class escapes lose their backslash at build time.
const parseBudgetParam = (search: string): number => { ... }
```

Semantics matched to the viewer exactly:
- Read the `budget=` value from the query string (must be preceded by `?` or `&`).
- `v = Number(value)` (NOT `parseInt` — the viewer allows floats, e.g. `?budget=8.5`).
- Return `v * 1_000_000` when `Number.isFinite(v) && v > 0`, else `0`.

### 2. Unit tests in `test/portal-preload.test.ts`

- `?budget=16` → `16_000_000`
- `?budget=8.5` → `8_500_000`
- missing param → `0`
- `?budget=0`, negative, non-numeric (`?budget=abc`) → `0`
- param not first in the query (`?webgl&budget=12`) → `12_000_000`
- substring guard: a key like `?maxbudget=5` must NOT match (`0`)

### 3. Wire into `src/viewer-companion/portals.ts`

- Stringify the helper alongside the existing `.toString()` helpers (near lines 76-79).
- Compute once near `residentBudgetOverride` (line 120): `var budgetOverride = parseBudgetParam(location.search);`
- Watchdog (line 874-876):
  ```js
  gs.splatBudget = budgetOverride || (IS_MOBILE ? 2 : 4) * 1000000;
  console.info('[portals] ready-gate watchdog applied fallback splatBudget=' + gs.splatBudget +
    (budgetOverride ? ' (from ?budget)' : ''));
  ```

## Out of scope

- Do **not** refactor the existing inline `residentBudgetOverride` (works today).
- The no-param default remains `2M` mobile / `4M` desktop — preserves the mobile-OOM guard.

## Verification

- Unit tests for `parseBudgetParam`; `npm run lint`; `npm run test`.
- Full behavior confirmation (stuck-`firstFrame` slow-network path is hard to stage reliably in a
  harness) is a manual release-build E2E: export a portal scene, load with `?budget=<n>` on a
  throttled network, confirm the watchdog log reports `splatBudget=<n·1e6> (from ?budget)`. Left to
  the user.
