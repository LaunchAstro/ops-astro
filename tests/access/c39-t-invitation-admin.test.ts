// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P1: an administrator's invitation asks `access:manage`. Holding
// `access:share` on the whole business lets a person invite and re-invite
// members, but an invitation naming the role `admin`, created or resent, also
// asks `access:manage` there, so a sharer never makes an administrator (not
// even of a second address of their own). Refused, it writes nothing. A revoke
// asks `access:share` alone. Who may invite at all is
// `c39-t-invitation-refusals.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  addressFor,
  as,
  c,
  codeOf,
  invitationRow,
  invite,
  noDatabase,
  peopleIn,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

async function invitationsTo(address: string): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.invitations where address = $1',
    [address],
  );
  return Number(row?.n);
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T administrator invitations', () => {
  it('C39-T admin role: an admin invitation from a person holding access:share but not access:manage is refused and writes nothing', async () => {
    const people = await peopleIn(w.alpha);
    const own = addressFor('second-own');
    const refused = await as(c.second, 'invitation.create', {
      name: 'Sam Second',
      email: own,
      role: 'admin',
    });
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(await invitationsTo(own)).toBe(0);
    expect(await peopleIn(w.alpha)).toBe(people);
    // The same person still invites a member.
    expect(await invitationRow(await invite(c.second))).toMatchObject({ role_key: 'member' });
    // A holder of access:manage invites an administrator.
    expect(await invitationRow(await invite(c.admin, own, 'admin'))).toMatchObject({
      role_key: 'admin',
      state: 'pending',
    });
  });

  it('C39-T admin role: resending an admin invitation asks access:manage too; a revoke asks access:share alone', async () => {
    const admin = await invite(c.admin, addressFor('admin-resend'), 'admin');
    const resent = await as(c.second, 'invitation.resend', { invitationId: admin });
    expect(codeOf(resent)).toBe('SCOPE_NOT_GRANTED');
    expect(await invitationRow(admin)).toMatchObject({ state: 'pending', revision: 1 });
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: admin }))).toBe('applied');
    expect(await invitationRow(admin)).toMatchObject({ revision: 2 });
    // A member's invitation is the sharer's to resend.
    const member = await invite(c.admin);
    expect(codeOf(await as(c.second, 'invitation.resend', { invitationId: member }))).toBe(
      'applied',
    );
    // Ending an administrator's invitation grants nothing: access:share is enough.
    expect(codeOf(await as(c.second, 'invitation.revoke', { invitationId: admin }))).toBe(
      'applied',
    );
    expect(await invitationRow(admin)).toMatchObject({ state: 'revoked' });
  });
});
