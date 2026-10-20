// SPDX-License-Identifier: AGPL-3.0-only
//
// A task call's request sized against its adapter's body limit before the
// hold (#2091), so one too large for its route is refused with nothing held,
// offered or sent. The send sizes it again (`tooLarge`, `broker-stop.ts`).

import type { ModelOperation } from '../../core-connectors/src/index.ts';
import { tooLarge } from './broker-stop.ts';
import type { ProviderAdapter, ResolvedField } from './broker-types.ts';

/** Before the hold: whether the request these fields build is over its adapter's body limit. */
export const oversized = (
  broker: { readonly providers: ReadonlyMap<string, ProviderAdapter> },
  operation: ModelOperation,
  fields: readonly ResolvedField[],
): boolean => {
  const adapter = broker.providers.get(operation.provider);
  if (adapter === undefined) return false;
  const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
  return tooLarge(adapter, adapter.build(values)) !== undefined;
};
