// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: C80's data effects, spread into `COMMAND_EFFECTS` (moved whole for the line cap).

import type { CommandName } from './command-names.ts';
import { business, client, writing, type DataEffects } from './data-effects-types.ts';

type LiveCorrectionCommand = Extract<
  CommandName,
  'settings.set_live_correction_approver' | `live_correction.${string}`
>;

export const LIVE_CORRECTION_EFFECTS: {
  readonly [Name in LiveCorrectionCommand]: DataEffects;
} = {
  'settings.set_live_correction_approver': writing(business('business_settings')),
  'live_correction.request': writing(client('live_corrections')),
  'live_correction.decide': writing(client('live_corrections')),
  'live_correction.read': writing([]),
};
