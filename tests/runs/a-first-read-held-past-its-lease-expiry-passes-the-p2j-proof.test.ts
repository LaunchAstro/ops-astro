// SPDX-License-Identifier: AGPL-3.0-only
//
// Proof by Sol (GPT-6.1-Sol), review of #1940 at f00e5a4d71, finding S1940-3;
// assertions unchanged.

import { describe, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { useDefinitionWorld } from './definition-world.ts';
import { aFirstReadHeldOnTheBusinessLockPastTheExpiry } from './definition-read-waits.ts';

describe.skipIf(serverUrl === undefined)('P2j', () => {
  useDefinitionWorld('sol1940p2j');
  it(
    'a first read held on the business lock past its expiry is refused with no text',
    aFirstReadHeldOnTheBusinessLockPastTheExpiry,
    60_000,
  );
});
