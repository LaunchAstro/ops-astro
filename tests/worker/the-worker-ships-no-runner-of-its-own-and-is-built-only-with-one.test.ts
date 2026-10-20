// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8c (#1717): the synthetic runner is gone. The step-runner module
// holds the runner's types and no runner, so nothing shipped can compute an
// accepted plan with nothing; and a worker is built only with the runner it
// is handed, the agent's in `apps/worker/main.ts`. The second case holds at
// compile time: `pnpm typecheck` fails on an unused `@ts-expect-error` the
// moment `runner` is optional again.

import { expect, it } from 'vitest';
import * as stepRunner from '../../apps/worker/step-runner.ts';
import type { WorkerOptions } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';

it('the step-runner module exports no runner, only its types', () => {
  expect(Object.keys(stepRunner)).toStrictEqual([]);
});

it('worker options without a runner do not type-check', () => {
  // @ts-expect-error a worker is built only with the runner that computes its plan
  const unrun: WorkerOptions = {
    transport: async () => await Promise.reject(new Error('never sent')),
    businessKey: 'alpha',
    credential: 'a-bearer',
    delegation: 'a-delegation',
    reporter: SYNTHETIC_USAGE,
  };
  expect(unrun).not.toHaveProperty('runner');
});
