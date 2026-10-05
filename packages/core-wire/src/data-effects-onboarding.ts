// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: new client onboarding's data effects (C41-A), `task.set_party`'s
// included, spread into `COMMAND_EFFECTS` in `data-effects.ts`. Moved whole
// from there to keep that file under the line limit.

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

type OnboardingCommand = Extract<
  CommandName,
  'record.create' | 'task.set_party' | `onboarding.${string}`
>;

export const ONBOARDING_EFFECTS: { readonly [Name in OnboardingCommand]: DataEffects } = {
  // New client onboarding (C41-A): the client row, its tasks laid out from a
  // template, a step's result as a comment on its task, and the inbox item
  // that parks a person or client-wait step with whoever owns its move.
  'record.create': writing(client('clients')),
  // A step task moved to another client is no longer anyone's move.
  'task.set_party': writing(client('records', 'record_unique_values', 'inbox_items')),
  'onboarding.start': writing(
    client('records', 'record_unique_values', 'onboardings', 'onboarding_steps', 'inbox_items'),
  ),
  'onboarding.step_result': writing(
    client('records', 'onboardings', 'onboarding_steps', 'inbox_items'),
  ),
};
