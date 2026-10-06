// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: what the workflow triggers' commands (C33, C52-A) do to data, a block
// of `COMMAND_EFFECTS` (data-effects.ts), which spreads it in.

import type { CommandName } from './surface.ts';
import { business, writing, type DataEffects } from './data-effects-types.ts';

type AutomationCommand = Extract<
  CommandName,
  | 'automation.registry'
  | 'activation.change'
  | 'definition.release'
  | 'activation.adopt'
  | 'activation.roll_back'
  | 'activation.turn_off'
  | 'approval.revoke'
>;

export const AUTOMATION_EFFECTS: { readonly [Name in AutomationCommand]: DataEffects } = {
  // Settings ▸ Workflow triggers (C33): a definition carries no client, so its
  // versions and activations are the business's own rows.
  'automation.registry': writing([]),
  'activation.change': writing(business('activations')),
  'definition.release': writing(business('automation_definitions', 'definition_versions')),
  // C52-A: an adoption pins and approves; a revocation is its own row.
  'activation.adopt': writing(business('activations', 'standing_approvals')),
  'activation.roll_back': writing(business('activations', 'standing_approvals')),
  'activation.turn_off': writing(business('activations')),
  'approval.revoke': writing(business('standing_approval_revocations')),
};
