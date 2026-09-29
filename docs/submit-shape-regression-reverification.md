# Submit-shape / phantom-click regression surface — re-verification

Re-run after the submit-shape predicate narrowing landed (test-001..test-004),
confirming every existing passing test in the surface below still passes
unmodified, plus the four new regression-pinning files added by those
subtasks.

## Pre-existing suite (13 files, 110 tests) — all passing

- `src/scraper/flow-runner.resolved-click-target-widened-submit-shape.test.ts`
- `src/scraper/flow-runner.n16-retarget-submit-shape-probe.test.ts`
- `src/scraper/flow-runner.xpath-tail-retarget-disambiguation.test.ts`
- `src/scraper/flow-runner.generic-action-button-submit-resolution-acceptance.test.ts`
- `src/scraper/flow-runner.correctly-resolved-fallback-submit-destination-credit-acceptance.test.ts`
- `src/scraper/flow-runner.final-step-toggle-not-submit-shaped-acceptance.test.ts`
- `src/scraper/flow-runner.mixed-submit-semantics-toggle-acceptance.test.ts`
- `src/scraper/flow-runner.submit-shaped-weak-signal-veto-acceptance.test.ts`
- `src/scraper/flow-runner.disabled-submit-click-acceptance.test.ts`
- `src/scraper/flow-runner.disabled-native-submit-input-veto.test.ts`
- `src/scraper/submit-control.test.ts`
- `src/scraper/phantom-click.test.ts`
- `src/scraper/phantom-click-escalation.test.ts`

## New regression-pinning suite (4 files, 16 tests) — all passing

- `src/scraper/flow-runner.non-submit-form-button-dom-delta-credit-regression.test.ts`
- `src/scraper/flow-runner.non-submit-form-button-tail-retarget-credit-regression.test.ts`
- `src/scraper/flow-runner.submit-shape-decision-site-parity-regression.test.ts`
- `src/scraper/flow-runner.submit-shape-veto-preserved-for-genuine-submit-regression.test.ts`

## Result

`pnpm test` scoped to the 17 files above: **17 test files, 126 tests, all
passing.** No regressions introduced by the submit-shape predicate narrowing.
