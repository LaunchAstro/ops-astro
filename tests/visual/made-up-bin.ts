// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up bin for the width-and-theme harness: the Tasks page's Deleted
// tab (#2346) shows one task an owner may restore. Typed against the wire
// contract, like made-up-api.ts, and test side only. Every name is made up.

import type { TaskBinResult } from '../../packages/core-wire/src/index.ts';
import { NATHAN } from './made-up-access.ts';

export const BIN_READS: { readonly 'task.bin': TaskBinResult } = {
  'task.bin': {
    ok: true,
    bin: [
      {
        batchId: 'batch-1',
        taskId: 't-deleted',
        key: 'T-21',
        title: 'Old landing page copy',
        deletedAt: '2026-09-21T23:10:00.000Z',
        deletedBy: NATHAN.name,
      },
    ],
    more: false,
  },
};
