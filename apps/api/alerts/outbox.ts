// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 error outbox, the API's half (the Vercel re-plan, section 11 step 2).

import type { Outbox } from '../../../packages/core-records/src/index.ts';
import type { Alerts, Place } from './sink.ts';

export function createOutboxAlerts(
  _options: Place & { readonly outbox: Outbox; readonly key: Uint8Array },
): Alerts {
  throw new Error('S0-2 outbox: not built');
}
