// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: C39-T's data effects, spread into `COMMAND_EFFECTS` (moved whole for the line cap).

import type { CommandName } from './command-names.ts';
import { READ } from './data-effects-shapes.ts';
import { business, writing, type DataEffects } from './data-effects-types.ts';

type InvitationCommand = Extract<CommandName, `invitation.${string}`>;

export const INVITATION_EFFECTS: { readonly [Name in InvitationCommand]: DataEffects } = {
  // Admits no outsider, sends nothing; a create writes its person, expiring a lapsed one.
  'invitation.create': writing(business('people', 'invitations', 'actors')),
  'invitation.resend': writing(business('invitations')),
  'invitation.revoke': writing(business('invitations')),
  'invitation.list': READ,
};
