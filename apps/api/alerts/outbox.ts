// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 error outbox, the API's half (the Vercel re-plan, section 11 step 2;
// the orchestrator's ruling STEP2-SHAPE). On Vercel an API instance keeps no
// count and reaches no sink: each security signal and each error is appended
// to `ops.api_events` (0047), and the environment's worker counts, raises,
// forwards and clears. A signal's scope is stored as an HMAC under a
// deploy-time key, so the table never holds a business key, subject, address
// or source, and a dictionary of them cannot be run against it; every
// instance holding the same key writes one digest for one scope. An error is
// its bounded event (`errorEvent`), exactly what the sink would have been sent.

import { createHmac } from 'node:crypto';
import type { ApiEvent, Outbox } from '../../../packages/core-records/src/index.ts';
import { scopeOf } from './detect.ts';
import { errorEvent, type Alerts, type Place } from './sink.ts';

export function createOutboxAlerts(
  options: Place & { readonly outbox: Outbox; readonly key: Uint8Array },
): Alerts {
  const pending = new Set<Promise<void>>();
  function append(event: ApiEvent): Promise<void> {
    const sent = options.outbox.append(event).catch(() => {
      console.error(
        'alerts: the outbox did not take an event; the forwarder heartbeat reports it.',
      );
    });
    pending.add(sent);
    void sent.finally(() => pending.delete(sent));
    return sent;
  }
  return {
    observe: (signal) => {
      const weight = signal.kind === 'export' ? signal.items : 1;
      if (weight < 1) return;
      const scope = createHmac('sha256', options.key).update(scopeOf(signal)).digest('hex');
      void append({ kind: signal.kind, scope, weight });
    },
    fault: async (cause) =>
      await append({ kind: 'error', scope: '', weight: 1, event: errorEvent(cause, options) }),
    settled: async () => void (await Promise.all(pending)),
  };
}
