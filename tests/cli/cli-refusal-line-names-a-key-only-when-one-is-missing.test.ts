// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's refusal line names the key a write needed only when the
// refusal says the caller lacks a key, by the same closed list the web page
// uses. A blocking cycle (TRANSITION_NOT_PERMITTED) is about the record: a
// writer who holds task:write is never told to get it.

import { describe, expect, it } from 'vitest';
import { REFUSAL_REGISTER } from '../../packages/core-records/src/register.ts';
import { refusalLine } from '../../apps/cli/render.ts';

const refusal = (code: string, names: readonly string[] = []) => ({ code, names, fixes: [] });

describe("the CLI's refusal line", () => {
  it('a blocking cycle names no key', () => {
    const line = refusalLine(refusal('TRANSITION_NOT_PERMITTED', ['blockedBy']), 'task:write');
    expect(line).toBe('refused TRANSITION_NOT_PERMITTED.');
  });

  it('a missing grant names the key the refusal names, else the declared one', () => {
    expect(refusalLine(refusal('SCOPE_NOT_GRANTED', ['task:assign']), 'task:write')).toBe(
      'refused SCOPE_NOT_GRANTED. You need task:assign.',
    );
    expect(refusalLine(refusal('SCOPE_NOT_GRANTED', ['recordId']), 'task:write')).toBe(
      'refused SCOPE_NOT_GRANTED. You need task:write.',
    );
  });

  it('no other registered code names a key', () => {
    const naming = REFUSAL_REGISTER.map((row) => row.code).filter((code) =>
      refusalLine(refusal(code), 'task:write').includes('You need'),
    );
    expect(naming).toStrictEqual(['SCOPE_NOT_GRANTED']);
  });
});
