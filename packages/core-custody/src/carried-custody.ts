// SPDX-License-Identifier: AGPL-3.0-only
//
// The carried custody (live chat route B): typed and inert until it is built.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { Carriage } from './carriage.ts';
import type { CarryKeys } from './carry-seal.ts';
import type { Custody } from './custody.ts';

export interface CarriedCustodyOptions {
  readonly carriage: Carriage;
  readonly keys: CarryKeys;
  readonly key: string;
  readonly now?: () => number;
}

export function carriedCustody(_options: CarriedCustodyOptions): Custody & {
  fenceIn(tx: TenantQuery, callId: string): Promise<boolean>;
} {
  return {
    pid: -1,
    dispatch: async () =>
      await Promise.resolve({ kind: 'refused', started: false, code: 'CARRIAGE_UNAVAILABLE' }),
    describe: async () =>
      await Promise.resolve({ credentialKind: 'api_key', account: null, presents: false }),
    fenceIn: async () => await Promise.resolve(true),
    stderr: () => '',
    raw: async () => await Promise.resolve({ type: 'refused' }),
    kill: () => {},
    stop: async () => {
      await Promise.resolve();
    },
  };
}
