// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: C41-A's data effects, set_party's and restore's included, spread into `COMMAND_EFFECTS` (moved whole for the line cap).

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

type OnboardingCommand = Extract<
  CommandName,
  'record.create' | 'task.set_party' | 'task.restore' | `onboarding.${string}`
>;

export const ONBOARDING_EFFECTS: { readonly [Name in OnboardingCommand]: DataEffects } = {
  // C41-A: the client row, its step tasks, a result comment, and the inbox item parking a step with its owner.
  'record.create': writing(client('clients')),
  // A step task moved to another client is no longer anyone's move.
  'task.set_party': writing(client('records', 'record_unique_values', 'inbox_items')),
  // A step that opened while its task was in the trash is parked with its owner on restore.
  'task.restore': writing(client('records', 'record_unique_values', 'inbox_items')),
  'onboarding.start': writing(
    client('records', 'record_unique_values', 'onboardings', 'onboarding_steps', 'inbox_items'),
  ),
  'onboarding.step_result': writing(
    client('records', 'onboardings', 'onboarding_steps', 'inbox_items'),
  ),
};
