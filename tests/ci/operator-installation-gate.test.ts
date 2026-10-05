// SPDX-License-Identifier: AGPL-3.0-only
//
// The installation-wide operator commands answer to the installation's
// operating business alone (OW-063.1's root, round 2): staging preparation
// allocates the installation's containers, the promotion migrates the whole
// database and points production, and the web deploy and the maintenance page
// serve every business. A manager of another business, holding
// `operations:manage` over all of it, is refused before anything is asked of
// Docker, launchctl or Vercel, and no record is written.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requireOperatingOperator, requireOperator } from '../../scripts/ops/operator.ts';
import {
  environment,
  operatorOnlyHooks,
  serverUrl,
  subjects,
  token,
} from './operator-only.fixture.ts';
import { COMMANDS, manager, marks } from './operator-only-commands.fixture.ts';

const INSTALLATION_WIDE = [
  'staging preparation',
  'the promotion step',
  'the web deploy',
  'the maintenance page',
];

describe.skipIf(serverUrl === undefined)('installation-wide commands, business to business', () => {
  operatorOnlyHooks(() => {});

  it.each(INSTALLATION_WIDE)('%s refuses a manager of another business', async (name) => {
    const fake = manager(false);
    const at = marks(fake);
    const env = environment(at, fake.path, {
      OPS_ASTRO_BUSINESS: 'beta',
      OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
    });
    // Positive controls: the caller is a real manager of beta, and beta is
    // not the installation's operating business.
    expect((await requireOperator(env)).ok).toBe(true);
    expect((await requireOperatingOperator(env)).ok).toBe(false);
    const result = COMMANDS[name]!(env, at);
    expect(
      {
        status: result.status,
        machine: existsSync(at.calls) ? readFileSync(at.calls, 'utf8') : '',
        records: readdirSync(at.records),
      },
      result.out,
    ).toEqual({ status: 1, machine: '', records: [] });
    // Refused by the installation's gate itself, not by a later step.
    expect(result.out).toMatch(
      /REFUSED: this act belongs to the installation's operating business alone/u,
    );
  });
});
