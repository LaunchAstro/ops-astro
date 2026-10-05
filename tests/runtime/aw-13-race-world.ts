// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 race helpers over the AW-13 world: a gate that pauses one export
// mid-flight, a delete ask whose call times out while the store queues it,
// and how far the export's cursor has come.

import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { expireOnce } from '../../packages/core-runtime/src/index.ts';
import { rows, type Schedules } from './schedules-harness.ts';
import { t, TRACE_KEY } from './aw-13-world.ts';

/** A pause: `arrive` resolves `reached` and waits until `release`. */
export interface Gate {
  readonly reached: Promise<void>;
  readonly arrive: () => Promise<void>;
  readonly release: () => void;
}

export function gate(): Gate {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    arrive: async () => {
      reach();
      await held;
    },
    release,
  };
}

/**
 * A retention pass whose delete the store queues while the call times out:
 * the ask is owed at the cursor's place. Answers the queued delete, to land
 * when the case says.
 */
export async function queuedAsk(s: Schedules): Promise<() => Promise<unknown>> {
  let queued: (() => Promise<unknown>) | undefined;
  const ports: ExpiryPorts = {
    expire: (ids) => {
      queued = async () => await t.target.expiry.expire(ids);
      return Promise.resolve({ ok: false, fault: 'timeout', status: null });
    },
    present: t.target.expiry.present,
  };
  const passes = await expireOnce(s.db.app, s.business, TRACE_KEY, ports);
  if (passes.at(-1)?.code !== 'target_timeout' || queued === undefined) {
    throw new Error('no delete was queued');
  }
  return queued;
}

/** How many of the business's events are at or behind the export's cursor. */
export async function behind(s: Schedules): Promise<number> {
  const [row] = await rows<{ n: number }>(
    s,
    `select count(*)::int as n from public.run_events ev
       join public.trace_export_cursors c on c.business_id = ev.business_id
      where ev.business_id = $1 and (ev.tx, ev.id) <= (c.after_tx, c.after_id)`,
    [s.business],
  );
  return row?.n ?? 0;
}
