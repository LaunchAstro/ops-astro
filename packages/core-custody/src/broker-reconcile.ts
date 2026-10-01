// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: the provider phase of the reconciliation pass (scaffold; the phase
// lands with its tests green).

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import type { Broker } from './broker-types.ts';

export interface ProviderProof {
  readonly callId: string;
  readonly proved: boolean;
  readonly reason: string;
}

export async function reconcileProviderCalls(
  _database: Database,
  _businessId: BusinessId,
  _broker: Omit<Broker, 'audit'>,
): Promise<readonly ProviderProof[]> {
  return await Promise.resolve([]);
}
