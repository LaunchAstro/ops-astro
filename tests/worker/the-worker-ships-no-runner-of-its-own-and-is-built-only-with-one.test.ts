// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R8c (#1717): the synthetic runner is gone. The step-runner module
// holds the runner's types and no runner, so nothing shipped can compute an
// accepted plan with nothing; and a worker is built only with the runner it
// is handed, the agent's in `apps/worker/main.ts`.

import { expect, it } from 'vitest';
import * as stepRunner from '../../apps/worker/step-runner.ts';

it('the step-runner module exports no runner, only its types', () => {
  expect(Object.keys(stepRunner)).toStrictEqual([]);
});
