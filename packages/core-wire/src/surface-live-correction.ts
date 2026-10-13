// SPDX-License-Identifier: AGPL-3.0-only
//
// The live-correction commands' operands (C80), spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand (moved whole for the line cap),
// and C80's two reads, spread into `COMMAND_SURFACE` in `surface.ts` (the same cap).

import type { CommandDeclaration } from './surface-declaration.ts';
import { read } from './surface-builders.ts';

/**
 * C80's reads, never an agent's. The decision read asks the request's own
 * `run:write` (ORCH33) at the correction's party; the sidebar door's site read
 * asks what a request asks, `run:write` at the task's client and `task:read`
 * on the task, both inside the read.
 */
export const LIVE_CORRECTION_READS: readonly CommandDeclaration[] = [
  read('live_correction.read', 'run', { action: 'write' }),
  read('live_correction.locate', 'run', { action: 'write' }),
];

export const LIVE_CORRECTION_OPERANDS = {
  'live_correction.request': {
    partyId: 'any',
    taskId: 'any',
    path: 'any',
    word: 'any',
    replacement: 'any',
    pageUrl: 'any',
    baseRevision: 'any',
    before: 'any',
    after: 'any',
  },
  'live_correction.decide': { correctionId: 'id', versionId: 'id', decision: 'text' },
  'settings.set_live_correction_approver': { value: 'any', expectedRevision: 'any' },
} as const;
