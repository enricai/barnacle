# urlChanged/retryUrlChanged tightening — regression re-verification

Re-run after the origin/path-only URL-credit fix landed (bugfix-001..005),
confirming every pre-existing flow-runner test still passes unmodified,
including the `verifiedBy="url"` acceptance suite, plus the new
regression-pinning tests added alongside the fix.

## Commands run

- `pnpm run lint:fix` — exit 0 (pre-existing warnings in unrelated files only;
  no errors).
- `pnpm run typecheck` — exit 0.
- `pnpm test src/scraper/flow-runner` — exit 0.

## Result

**200 test files, 760 tests, all passing.** No regressions from the
urlChanged/retryUrlChanged tightening.

Includes the pre-existing `verifiedBy="url"`-asserting acceptance tests:

- `src/scraper/flow-runner.captcha-gated-submit-navigation-credit-acceptance.test.ts`
- `src/scraper/flow-runner.submit-verify-frame-scope.test.ts`
- `src/scraper/flow-runner.captcha-gated-fallback-phantom-click-retry-acceptance.test.ts`

and the new regression-pinning tests added by bugfix-003/004/005:

- `src/scraper/flow-runner.cosmetic-query-reload-no-url-credit-regression.test.ts`
- `src/scraper/flow-runner.cosmetic-query-reload-submit-shaped-no-judge-regression.test.ts`
- `src/scraper/flow-runner.genuine-navigation-url-credit-regression-acceptance.test.ts`
- `src/scraper/flow-runner.n16-retry-cosmetic-query-reload-no-url-credit-regression.test.ts`
- `src/scraper/flow-runner.reload-only-url-credit-veto-acceptance.test.ts`
- `src/scraper/flow-runner.submit-shaped-unreachable-judge-reload-url-credit-veto-acceptance.test.ts`
- `src/scraper/flow-runner.retry-fallback-reload-only-url-credit-veto-acceptance.test.ts`
