// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part two: agent parity through the owning command (standing gate 7,
// API-1). The harness read is one row of the command surface, so the parity
// check finds it on every surface with the same profile: the person API, the
// command line, and the agent API, where the row is person-only and an agent
// is refused. The planted case drops the CLI verb and shows the check fails.
//
// This suite moves the database counter by zero, so it is a unit suite and
// is not named in `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import { checkParity, type Profile } from '../../packages/core-wire/src/index.ts';
// @ts-expect-error -- a plain script with no declaration file
import { realSurfaces } from '../../scripts/command-parity.mjs';
import { real } from './api-1-catalogue-support.ts';

const NAME = 'harness.read';

describe('AW-12 harness read parity', () => {
  it('AW-12 parity: the parity check lists the harness read on the API, the CLI and the agent surface', () => {
    const { rows, failures } = real();
    expect(failures).toEqual([]);
    const row = rows.find((one) => (one.command as string) === NAME);
    expect(row).toMatchObject({
      kind: 'read',
      agent: 'never',
      permissionKey: 'task:read',
      authority: ['task:read'],
      authorisedOn: 'business',
      personOnly: true,
      cli: NAME,
      api: { person: '/api/b/:businessKey/harness/read', agent: null },
    });
    const surfaces = realSurfaces([]) as Record<'api' | 'agent' | 'cli', Map<string, Profile>>;
    for (const surface of ['api', 'agent', 'cli'] as const) {
      expect(surfaces[surface].get(NAME), surface).toEqual({
        authority: ['task:read'],
        authorisedOn: 'business',
        personOnly: true,
        rule: '',
      });
    }
  });

  it('AW-12 parity: the command line losing the harness verb fails the check', () => {
    const { rows } = real();
    const surfaces = realSurfaces([]);
    const cli = new Map(surfaces.cli as Map<string, Profile>);
    cli.delete(NAME);
    expect(checkParity(rows, { ...surfaces, cli })).toEqual([`${NAME} has no CLI equivalent`]);
  });
});
