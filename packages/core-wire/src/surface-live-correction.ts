// SPDX-License-Identifier: AGPL-3.0-only
//
// The live-correction commands' operands (C80), spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand (moved whole for the line cap).

export const LIVE_CORRECTION_OPERANDS = {
  'live_correction.request': { taskId: 'any', page: 'any', word: 'any', replacement: 'any' },
  'live_correction.decide': { correctionId: 'id', versionId: 'id', decision: 'text' },
  'live_correction.revert': { correctionId: 'id' },
  'settings.set_live_correction_approver': { value: 'any', expectedRevision: 'any' },
} as const;

/**
 * Where the approval and the revert ask are asked: `gate:decide` at the
 * correction's own party (`prepare.ts`), never an agent's. Their rows in
 * `surface.ts`, which is at its line limit, take these whole.
 */
export const DECIDE_AT_CORRECTION = {
  collection: 'gate',
  targetsExistingRecord: false,
  authorisedOn: 'target',
  untargetedIdentifiers: ['correctionId', 'versionId'],
} as const;
export const REVERT_AT_CORRECTION = {
  collection: 'gate',
  targetsExistingRecord: false,
  authorisedOn: 'target',
  untargetedIdentifiers: ['correctionId'],
} as const;
