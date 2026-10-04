// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for C39-T's team invitations, split from
// role-case-positive-body.ts to keep that file under the line limit. The admin
// holds `access:share`; each recipe invites an address nobody holds yet. Where
// the world can, each recipe also enrols a fresh inviter (`freshInviter`), so a
// run of many cells never meets the 30-an-hour limit on one account.

import { randomUUID } from 'node:crypto';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

import type { CommandName } from '../../packages/core-wire/src/surface.ts';

type InvitationCommand = 'invitation.create' | 'invitation.resend' | 'invitation.revoke';

export const isInvitation = (name: CommandName): name is InvitationCommand =>
  name === 'invitation.create' || name === 'invitation.resend' || name === 'invitation.revoke';

/** A team invitation to an address nobody holds yet. */
const invitee = (): Record<string, unknown> => ({
  name: 'Invited Ivy',
  email: `ivy-${randomUUID()}@example.test`,
  role: 'member',
});

export async function invitationBody(
  name: InvitationCommand,
  context: BodyContext,
): Promise<Prepared> {
  await context.freshInviter?.();
  if (name === 'invitation.create') return { body: invitee() };
  const made = await context.asPerson('invitation.create', invitee());
  if (made.code !== 'ok') throw new Error(`matrix: invitation refused ${made.code}`);
  return { body: { invitationId: String(made.body['recordId']) } };
}
