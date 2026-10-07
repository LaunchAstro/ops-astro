// SPDX-License-Identifier: AGPL-3.0-only
//
// A refused write on the map page names the key it needed only when the
// refusal says the reader lacks a key. Every other registered code, including
// ones whose spelling carries PERMIT, AUTH, GRANT, DELEGATION or AGENT, adds
// nothing: those are about the record or the session, not a missing key.

import { describe, expect, it } from 'vitest';
import { REFUSAL_REGISTER } from '../../packages/core-records/src/register.ts';
import { needsKey } from '../../apps/web/src/records/needs-key.ts';

const refusal = (code: string) => ({ code, names: [], fixes: [] }) as never;

describe('the key a refused map write names', () => {
  it('a missing grant names the key the command is declared with', () => {
    expect(needsKey('task.set_blocking', refusal('SCOPE_NOT_GRANTED'))).toBe(
      'You need task:write.',
    );
  });

  it('a blocking cycle names no key', () => {
    expect(needsKey('task.set_blocking', refusal('TRANSITION_NOT_PERMITTED'))).toBeNull();
  });

  it('no other registered code names a key', () => {
    const naming = REFUSAL_REGISTER.map((row) => row.code).filter(
      (code) => needsKey('map.revise', refusal(code)) !== null,
    );
    expect(naming).toStrictEqual(['SCOPE_NOT_GRANTED']);
  });
});
