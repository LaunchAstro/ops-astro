// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import {
  environment,
  operatorOnlyHooks,
  serverUrl,
  subjects,
  token,
} from '../ci/operator-only.fixture.ts';
import { manager, marks } from '../ci/operator-only-commands.fixture.ts';
import { fake, spawn, STOP } from '../ci/service-stop.fixture.ts';

describe.skipIf(serverUrl === undefined)('installation operator boundary', () => {
  operatorOnlyHooks(() => {});
  it('business to business, a non-operating business cannot stop production', async () => {
    const stopped = fake();
    const env = environment(marks(manager(false)), stopped.path, {
      OPS_ASTRO_BUSINESS: 'beta',
      OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
      OPS_ASTRO_DEPLOYMENTS: stopped.records,
    });
    const scoped = await requireOperatingOperator(env);
    expect(scoped.ok, 'positive control: beta is outside the recorded operating business').toBe(false);
    const result = spawn(STOP, [], env);
    expect({ status: result.status, calledDocker: existsSync(stopped.calls) }).toEqual({
      status: 1,
      calledDocker: false,
    });
  });
});
