// SPDX-License-Identifier: AGPL-3.0-only
//
// The declining usage reporter: a reporter that never reports what a step
// cost (specification 12.2). T3b drives the sweeper's unknown liability with
// it. It lives here, under `tests/`, because only a test build may reach it:
// `.dependency-cruiser.cjs` refuses any shippable module that imports from
// `tests/`, and `tests/worker/worker-boundary.test.ts` plants the import to
// prove the rule fires.

import type { UsageReporter } from '../../apps/worker/usage.ts';

export const DECLINING_REPORTER: UsageReporter = {
  estimate: () => 2_500,
  observe: () => null,
};
