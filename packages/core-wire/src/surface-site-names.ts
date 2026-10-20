// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction commands' names, part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-launch-names.ts` is.

/**
 * C80's live correction: an agent may request it, a person decides the exact version and
 * asks its revert, a setting names who; the publish, revert and receipt are system writes.
 */
export type SiteCommandName =
  | 'live_correction.request'
  | 'live_correction.read'
  | 'live_correction.list'
  | 'live_correction.receipts'
  | 'live_correction.decide'
  | 'live_correction.revert'
  | 'live_correction.record_review'
  | 'settings.set_live_correction_approver'
  | 'settings.set_single_operator';
