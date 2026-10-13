// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each case keeps its schedule in one place */
//
// An invitation accepted on its one-time link: the token alone is the
// authority, and the accept seats the invited person with no grant and owes
// their login to the provider. Every link that is not live is one answer
// that writes nothing. The first-client gate refuses it as it refuses
// `invitation.create`.

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountEnrolment } from '../../apps/api/enrolment.ts';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import {
  as,
  auditOf,
  c,
  codeOf,
  noDatabase,
  send,
  storedText,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';
import { invited, NOTHING, one, seated } from './enrolment-accept-world.ts';

useInvitationWorld();

describe.skipIf(noDatabase)('an invitation accepted on its one-time link', () => {
  it('seats the invited person with no grant, owes their login, and audits both acts', async () => {
    const { id, token, address } = await invited();
    expect(await acceptInvitation(w.db.app, token)).toStrictEqual({ ok: true });
    expect(await seated(id)).toStrictEqual({
      state: 'accepted',
      spent: 1,
      actors: 1,
      memberships: 1,
      logins: 1,
      grants: 0,
      owed: 1,
    });
    const login = await one<{
      provider: string;
      role_key: string;
      linked_by: string;
      state: string;
    }>(
      `select l.provider, m.role_key, pl.linked_by_actor_id as linked_by, p.state
         from login_provisions p
         join logins l on l.business_id = p.business_id and l.id = p.login_id
         join person_logins pl on pl.business_id = l.business_id and pl.login_id = l.id
         join invitations i on i.business_id = p.business_id and i.id = p.invitation_id
         join memberships m on m.business_id = i.business_id and m.person_id = i.person_id
        where p.invitation_id = $1`,
      [id],
    );
    expect(login).toStrictEqual({
      provider: 'supabase',
      role_key: 'member',
      linked_by: c.admin.actorId,
      state: 'owed',
    });
    const confirmed = await one<{ review_state: string }>(
      `select pi.review_state from person_identifiers pi
         join invitations i on i.business_id = pi.business_id and i.person_id = pi.person_id
        where i.id = $1 and pi.kind = 'email' and pi.value = $2`,
      [id, address],
    );
    expect(confirmed.review_state).toBe('confirmed');
    expect((await auditOf(id)).map((event) => event.command)).toContain('invitation.accept');
    const loginId = (
      await one<{ login_id: string }>(
        'select login_id from login_provisions where invitation_id = $1',
        [id],
      )
    ).login_id;
    expect((await auditOf(loginId)).map((event) => event.command)).toStrictEqual(['login.create']);
    // The address is now a member's: a new invitation to it is refused.
    expect(
      codeOf(
        await as(c.admin, 'invitation.create', { name: 'Jo', email: address, role: 'member' }),
      ),
    ).toBe('UNIQUE_VALUE_TAKEN');
  });

  it('answers every dead link alike and writes nothing', async () => {
    const spent = await invited();
    expect(await acceptInvitation(w.db.app, spent.token)).toStrictEqual({ ok: true });
    const expired = await invited();
    await w.db.admin.execute(
      `update enrolment_tokens set expires_at = clock_timestamp() - interval '1 second'
        where invitation_id = $1`,
      [expired.id],
    );
    const revoked = await invited();
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: revoked.id }))).toBe(
      'applied',
    );
    const superseded = await invited();
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: superseded.id }))).toBe(
      'applied',
    );
    expect(await send(superseded.id)).toMatchObject({ ok: true });
    const cases = [
      ['unknown', randomBytes(32).toString('base64url')],
      ['malformed', 'not-a-token'],
      ['spent', spent.token],
      ['expired', expired.token],
      ['revoked', revoked.token],
      ['superseded', superseded.token],
    ] as const;
    for (const [, token] of cases) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is judged on its own
      expect(await acceptInvitation(w.db.app, token)).toStrictEqual({
        ok: false,
        code: 'ENROLMENT_LINK_INVALID',
      });
    }
    for (const id of [expired.id, revoked.id, superseded.id]) {
      // eslint-disable-next-line no-await-in-loop -- one invitation at a time
      expect(await seated(id)).toMatchObject(NOTHING);
    }
  });

  it('refuses once its inviter no longer holds access:share', async () => {
    const { id, token } = await invited(c.second);
    await w.db.admin.execute(
      `update grants set revoked_at = clock_timestamp()
        where subject_id in ($1, $2) and collection = 'access' and action = 'share'`,
      [c.second.personId, c.second.actorId],
    );
    expect(await acceptInvitation(w.db.app, token)).toStrictEqual({
      ok: false,
      code: 'ENROLMENT_LINK_INVALID',
    });
    expect(await seated(id)).toMatchObject({ state: 'pending', ...NOTHING });
  });

  it('is refused while the installation holds real data with a gate item open', async () => {
    const { id, token } = await invited();
    // Real data with an item open: set up as the owner, past the one-way trigger
    // that would refuse it, the state an item reopened after the move leaves.
    await w.db.admin.execute('alter table ops.installation disable trigger installation_one_way');
    await w.db.admin.execute("update ops.installation set mode = 'real'");
    await w.db.admin.execute('alter table ops.installation enable trigger installation_one_way');
    try {
      expect(await acceptInvitation(w.db.app, token)).toStrictEqual({
        ok: false,
        code: 'ENROLMENT_NOT_YET',
      });
      expect(await seated(id)).toMatchObject({ state: 'pending', ...NOTHING });
    } finally {
      await w.db.admin.execute('alter table ops.installation disable trigger installation_one_way');
      await w.db.admin.execute("update ops.installation set mode = 'made-up'");
      await w.db.admin.execute('alter table ops.installation enable trigger installation_one_way');
    }
  });

  it("accepts another business's invitation in that business alone", async () => {
    const before = await one<{ n: number }>(
      'select count(*)::int as n from memberships where business_id = $1',
      [w.alpha],
    );
    const { id, token } = await invited(c.bravoAdmin, 'member', w.bravo);
    expect(await acceptInvitation(w.db.app, token)).toStrictEqual({ ok: true });
    const row = await one<{ business_id: string }>(
      'select business_id from login_provisions where invitation_id = $1',
      [id],
    );
    expect(row.business_id).toBe(w.bravo);
    expect(
      await one('select count(*)::int as n from memberships where business_id = $1', [w.alpha]),
    ).toStrictEqual(before);
  });

  it('keeps no token anywhere but its hash', async () => {
    const { token } = await invited();
    expect(await acceptInvitation(w.db.app, token)).toStrictEqual({ ok: true });
    const provisions = await w.db.admin.execute<{ t: string }>(
      "select coalesce(string_agg(to_jsonb(p)::text, ' '), '') as t from public.login_provisions p",
    );
    expect(`${await storedText()} ${provisions[0]?.t ?? ''}`).not.toContain(token);
  });

  it('answers the route with codes alone', async () => {
    const server = new Hono();
    mountEnrolment(server, w.db.app);
    const post = async (body: string): Promise<[number, unknown]> => {
      const answer = await server.fetch(
        new Request('http://api.test/api/enrol', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      return [answer.status, await answer.json()];
    };
    const { token } = await invited();
    expect(await post(JSON.stringify({ token }))).toStrictEqual([200, { accepted: true }]);
    expect(await post(JSON.stringify({ token }))).toStrictEqual([
      401,
      { code: 'ENROLMENT_LINK_INVALID' },
    ]);
    expect(await post('{')).toStrictEqual([400, { code: 'ENROLMENT_MALFORMED' }]);
    expect(await post(JSON.stringify({ token: 'x'.repeat(300) }))).toStrictEqual([
      413,
      { code: 'ENROLMENT_TOO_LARGE' },
    ]);
  });
});
