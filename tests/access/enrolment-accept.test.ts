// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each case keeps its schedule in one place */
//
// An invitation accepted on its one-time link: the token alone is the
// authority, and the accept seats the invited person with no grant and owes
// their login to the provider. Every link that is not live is one answer
// that writes nothing. The accept judges everything after its last lock wait,
// on the clock, in the order every invitation writer takes its locks, so two
// accepts, or an accept beside a revoke or a resend, end in one consistent
// state. The first-client gate refuses it as it refuses `invitation.create`.

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountEnrolment } from '../../apps/api/enrolment.ts';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import { connect, lockAccess } from '../../packages/core-records/src/index.ts';
import {
  addressFor,
  as,
  auditOf,
  c,
  codeOf,
  linkIn,
  noDatabase,
  send,
  storedText,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

/** A gate a schedule holds closed until it lets the waiting side on. */
function latch(): { readonly opened: Promise<void>; open: () => void } {
  const gate = { opened: Promise.resolve(), open: (): void => {} };
  gate.opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return gate;
}

/** Invite, send, and the token the mail carried. */
async function invited(
  who = c.admin,
  role = 'member',
  business = w.alpha,
): Promise<{ id: string; token: string; address: string }> {
  const address = addressFor('joiner');
  const result = await as(who, 'invitation.create', { name: 'Jo Joiner', email: address, role });
  const id = String((result as { recordId?: unknown }).recordId);
  expect(await send(id, business)).toMatchObject({ ok: true });
  return { id, token: linkIn(w.provider.outbox.at(-1)?.body).token, address };
}

async function one<T extends Record<string, unknown>>(sql: string, values: unknown[]): Promise<T> {
  const [row] = await w.db.admin.execute<T>(sql, values);
  return row as T;
}

/** What an accept writes, counted for one invitation's person. */
async function seated(invitationId: string): Promise<Record<string, unknown>> {
  return await one(
    `select i.state,
            (select count(*)::int from enrolment_tokens t
              where t.invitation_id = i.id and t.spent_at is not null) as spent,
            (select count(*)::int from actors a
              where a.person_id = i.person_id and a.kind = 'person' and a.active) as actors,
            (select count(*)::int from memberships m where m.person_id = i.person_id and m.active) as memberships,
            (select count(*)::int from person_logins pl where pl.person_id = i.person_id and pl.active) as logins,
            (select count(*)::int from grants g where g.subject_id = i.person_id
                or g.subject_id in (select id from actors where person_id = i.person_id)) as grants,
            (select count(*)::int from login_provisions p where p.invitation_id = i.id) as owed
       from invitations i where i.id = $1`,
    [invitationId],
  );
}

const NOTHING = { spent: 0, actors: 0, memberships: 0, logins: 0, grants: 0, owed: 0 };

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

describe.skipIf(noDatabase)('accepts beside each other and beside other acts', () => {
  it('two accepts of one link at once seat one person once', async () => {
    const { id, token } = await invited();
    const [a, b] = [connect(w.db.appUrl), connect(w.db.appUrl)];
    try {
      const answers = await Promise.all([acceptInvitation(a, token), acceptInvitation(b, token)]);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(await seated(id)).toMatchObject({
        state: 'accepted',
        actors: 1,
        memberships: 1,
        owed: 1,
      });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it.each(['invitation.revoke', 'invitation.resend'])(
    'an accept beside %s ends in one consistent state, with no deadlock',
    async (command) => {
      const { id, token } = await invited();
      const [held, other] = [connect(w.db.appUrl), connect(w.db.appUrl)];
      try {
        // Both queue behind one holder of the access lock, then race for the row.
        const gate = latch();
        const holding = held.withBusiness(w.alpha, async (tx) => {
          await lockAccess(tx);
          await gate.opened;
        });
        await delay(100);
        const accepting = acceptInvitation(other, token);
        const acting = as(c.admin, command, { invitationId: id });
        await delay(300);
        gate.open();
        await holding;
        const [accepted, acted] = await Promise.all([accepting, acting]);
        const state = await seated(id);
        if (accepted.ok) {
          expect(state).toMatchObject({ state: 'accepted', memberships: 1, owed: 1 });
          expect(codeOf(acted)).toBe('TRANSITION_NOT_PERMITTED');
        } else {
          expect(codeOf(acted)).toBe('applied');
          expect(state).toMatchObject({ memberships: 0, owed: 0, spent: 0 });
        }
      } finally {
        await Promise.all([held.close(), other.close()]);
      }
    },
  );

  it('a lifetime that ends while the accept waits on the access lock refuses it', async () => {
    const { id, token } = await invited();
    await w.db.admin.execute(
      `update invitations set expires_at = clock_timestamp() + interval '1500 milliseconds'
        where id = $1`,
      [id],
    );
    const [held, other] = [connect(w.db.appUrl), connect(w.db.appUrl)];
    try {
      const gate = latch();
      const holding = held.withBusiness(w.alpha, async (tx) => {
        await lockAccess(tx);
        await gate.opened;
      });
      await delay(100);
      const accepting = acceptInvitation(other, token);
      await delay(2000);
      gate.open();
      await holding;
      expect(await accepting).toStrictEqual({ ok: false, code: 'ENROLMENT_LINK_INVALID' });
      expect(await seated(id)).toMatchObject(NOTHING);
    } finally {
      await Promise.all([held.close(), other.close()]);
    }
  });
});
