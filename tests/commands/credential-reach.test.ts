// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 reach, by construction: an agent never decides, shares or manages, so
// no row with one of those actions is in an agent credential's reach,
// whatever keys a credential row carries. The ticked keys and the scope's
// check constraint are the other two layers, not this one.

import { expect, it } from 'vitest';
import { CREDENTIAL_REACH } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';

it('API-2 reach: no decide, share or manage row is in an agent credential reach', () => {
  const personal = COMMAND_SURFACE.filter((row) =>
    ['decide', 'share', 'manage'].includes(row.action),
  ).map((row) => row.name);
  expect(personal).toContain('task.decide');
  expect(personal.filter((name) => CREDENTIAL_REACH.has(name))).toEqual([]);
});
