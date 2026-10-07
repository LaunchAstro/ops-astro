// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's keys (C31) for Settings in the width-and-theme harness: one set,
// one not, never a value. Test side only, like the rest of `made-up-*.ts`.

import type { SecretListResult } from '../../packages/core-wire/src/index.ts';

export const SECRET_LIST: SecretListResult = {
  ok: true,
  canChange: true,
  secrets: [
    {
      id: 'S-1',
      name: 'xero.client-secret',
      clientId: null,
      state: 'set',
      setAt: '2026-09-30T00:00:00Z',
      lastUsedAt: null,
      revision: 1,
    },
    {
      id: 'S-2',
      name: 'ads.token',
      clientId: null,
      state: 'not set',
      setAt: null,
      lastUsedAt: null,
      revision: 2,
    },
  ],
};
