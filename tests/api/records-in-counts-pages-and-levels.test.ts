// SPDX-License-Identifier: AGPL-3.0-only
//
// The export-volume signal and the agent quota count the records a read hands
// out (`apps/api/records-in.ts`). A page of the board and a task read at a
// detail level (API-3) hand out records like the answers they project: a page
// is its items, a leveled task is one, on the person prefix and the agent's.

import { describe, expect, it } from 'vitest';
import { recordsIn } from '../../apps/api/records-in.ts';

describe('records handed out by a page or a detail level', () => {
  it('a page of the board counts its items', () => {
    const page = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(recordsIn({ ok: true, page, next: 'token' })).toBe(3);
    expect(recordsIn({ ok: true, page: [], next: null })).toBe(0);
  });

  it('a task read at any level counts one, as the agent prefix hands it out too', () => {
    for (const detail of ['brief', 'standard', 'full']) {
      expect(recordsIn({ ok: true, detail, view: { id: 'a' } }), detail).toBe(1);
      expect(recordsIn({ detail, view: { id: 'a' } }), `agent ${detail}`).toBe(1);
    }
  });
});
