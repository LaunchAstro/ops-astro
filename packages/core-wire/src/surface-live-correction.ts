// SPDX-License-Identifier: AGPL-3.0-only
//
// The live-correction commands' operands (C80), spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand (moved whole for the line cap).

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
