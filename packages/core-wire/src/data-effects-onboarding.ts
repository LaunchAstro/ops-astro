// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: C41-A's data effects, set_party's included, spread into `COMMAND_EFFECTS` (moved whole for the line cap).

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

type OnboardingCommand = Extract<
  CommandName,
  'record.create' | 'task.set_party' | `onboarding.${string}`
>;

export const ONBOARDING_EFFECTS: { readonly [Name in OnboardingCommand]: DataEffects } = {
  // C41-A: the client row, its step tasks, and a step's result as a comment.
  'record.create': writing(client('clients')),
  'task.set_party': writing(client('records', 'record_unique_values')),
  'onboarding.start': writing(
    client('records', 'record_unique_values', 'onboardings', 'onboarding_steps'),
  ),
  'onboarding.step_result': writing(client('records', 'onboardings', 'onboarding_steps')),
};
