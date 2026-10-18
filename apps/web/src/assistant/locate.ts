// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693: the correction door's port. It sends `live_correction.request` with
// the task the drawer was opened from, the page as the person named it and
// the two words, and nothing else. The server finds the page from the task
// and the site runner reads the file on the M5, so the browser never sees it.

import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import type { ProposePort } from './correction.ts';

/** The door's port for one task, bound to `live_correction.request` through the command client. */
export const taskCorrectionPort =
  (client: OperationsClient, taskId: string): ProposePort =>
  async (ask) => {
    const { page, word, replacement } = ask;
    const operands = { taskId, page, word, replacement };
    const settled = settle(await client.mutate('live_correction.request', operands));
    if (settled.kind === 'unknown') return { ok: false, code: 'UNAVAILABLE' };
    if (settled.kind !== 'ok') return { ok: false, code: settled.refusal.code };
    const id = settled.value.detail?.['correctionId'];
    return typeof id === 'string'
      ? { ok: true, correctionId: id }
      : { ok: false, code: 'UNAVAILABLE' };
  };
