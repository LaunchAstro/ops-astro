// SPDX-License-Identifier: AGPL-3.0-only
//
// An access ending or a factor reset has committed before its provider steps
// are tried (`apps/api/settle-after-commit.ts`). A throw while trying them,
// the database gone mid-settle or a provider client that throws, leaves the
// steps owed for the endings loop and answers the act's own result: the act
// is done, so the caller is never told it failed.

import { describe, expect, it } from 'vitest';
import { settleAfterCommit } from '../../apps/api/settle-after-commit.ts';
import type { LoginProvider } from '../../packages/core-commands/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

const BUSINESS = '00000000-0000-4000-8000-000000000001' as BusinessId;
const ENDING = '00000000-0000-4000-8000-0000000000e1';

/** A database whose every statement throws, as one that dropped after the act committed. */
const gone = (): Promise<never> => Promise.reject(new Error('the connection ended'));
const dropped = {
  withBusiness: gone,
  close: gone,
} as unknown as Database;

const logins: LoginProvider = {
  endSessions: async () => await Promise.resolve({ ok: true, value: undefined }),
  deactivate: async () => await Promise.resolve({ ok: true, value: undefined }),
};

const options = {
  database: dropped,
  logins,
  sharedLogin: async () => await Promise.resolve(false),
};

describe('a settle after commit that throws', () => {
  it('answers a committed access ending as done, its steps left owed', async () => {
    const ended = { command: 'access.end', detail: { endingIds: [ENDING] } };
    await expect(settleAfterCommit(options, BUSINESS, 'access.end', ended)).resolves.toBe(ended);
  });

  it('answers a committed factor reset with no provider step claimed done', async () => {
    const reset = { command: 'access.reset_factor', detail: { resetId: ENDING } };
    await expect(settleAfterCommit(options, BUSINESS, 'access.reset_factor', reset)).resolves.toBe(
      reset,
    );
  });
});
