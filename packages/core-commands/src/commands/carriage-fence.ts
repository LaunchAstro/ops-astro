// SPDX-License-Identifier: AGPL-3.0-only
//
// The send fence both carriages share (`carriage-origin.ts` for a
// conversation's call, `task-carriage.ts` for a task's): the send judgement
// runs in the opener's transaction and, once it passes, that transaction holds
// its locks until the agent reports the write or a refusal, or W after the
// accept was heard.

import type { Handoff, Judged } from '../../../core-custody/src/index.ts';
import { SEND_WINDOW_MS } from '../../../core-custody/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

export const LOST = { ok: false, code: 'AUTHORITY_LOST' } as const;

const nothing = (): void => {};

/** Grant contention under the `nowait` hold: nothing was sent, so the call is released. */
export const busy = (cause: unknown): { readonly ok: false; readonly code: string } => {
  if ((cause as { readonly code?: unknown }).code !== '55P03') throw cause;
  return { ok: false, code: 'AUTHORITY_BUSY' };
};

type Fenced = Awaited<ReturnType<Handoff['fence']>>;

/** The send judgement in `open`'s transaction, its locks held until released or W after `heardAt`. */
export function holdSend<By>(
  open: (work: (tx: TenantQuery, by: By) => Promise<void>) => Promise<unknown>,
  judge: (tx: TenantQuery, by: By) => Promise<Judged>,
  heardAt: number,
): Promise<Fenced> {
  return new Promise<Fenced>((ready) => {
    let letGo = nothing;
    const released = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const running = open(async (tx, by) => {
      const passed = await judge(tx, by);
      if (!passed.ok) {
        ready(passed);
        return;
      }
      await tx.query(`set local idle_in_transaction_session_timeout = '10s'`);
      ready({
        ok: true,
        release: async () => {
          letGo();
          await running;
        },
      });
      const left = Math.max(0, heardAt + SEND_WINDOW_MS - Date.now());
      await Promise.race([
        released,
        new Promise((resolve) => {
          setTimeout(resolve, left);
        }),
      ]);
    })
      .catch((cause: unknown) => {
        ready(busy(cause));
      })
      .catch(() => {
        ready({ ok: false, code: 'CARRIAGE_UNAVAILABLE' });
      })
      .finally(() => {
        // A session that no longer resolves answered nothing above: its authority is gone.
        ready(LOST);
      });
  });
}
