// SPDX-License-Identifier: AGPL-3.0-only
//
// A step runner that computes nothing and ends in success, for the tests whose
// worker reaches an accepted plan's compute but proves something else: the
// proposal, pickup, apply, sign-off and receipt paths. The shipped worker has
// no runner of its own and hands the agent's (`apps/worker/main.ts`, #1717
// R8c), so this lives under `tests/`, which `.dependency-cruiser.cjs` keeps
// out of every shippable module. A test about the compute itself hands the
// agent's runner or its own.

import type { StepRunner } from '../../apps/worker/step-runner.ts';

export const COMPUTES_NOTHING: StepRunner = {
  compute: async () => await Promise.resolve({ outcome: 'success', endCode: 'COMPLETED' }),
};
