// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { tempDir } from './fixtures/plan-token-world.ts';

it.each([false, true])(
  'a lock whose writable probe crosses its deadline (slow=%s) runs no late work',
  async (slow) => {
    const w = tempDir();
    const original = DatabaseSync.prototype.exec;
    let at = 0;
    let realProbe = false;
    let entered = false;
    try {
      DatabaseSync.prototype.exec = function (sql: string) {
        const result = original.call(this, sql);
        if (sql.startsWith('SAVEPOINT probe;')) {
          realProbe = true;
          if (slow) at = 1000;
        }
        return result;
      };
      const result = await withTokenLock(w.file, { deadlineAt: 500, now: () => at }, () => {
        entered = true;
        return Promise.resolve('ran');
      });
      expect(realProbe).toBe(true);
      expect(entered).toBe(!slow);
      expect(result).toEqual(
        slow ? { held: false, why: 'LOCK_WAIT_LAPSED' } : { held: true, value: 'ran' },
      );
    } finally {
      DatabaseSync.prototype.exec = original;
      w.done();
    }
  },
);
