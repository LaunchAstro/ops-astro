// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared helpers for the enrolment accept suites: an invitation sent and its
// link's token, what an accept writes for one invitation, and a latch a
// schedule holds closed.

import { expect } from 'vitest';
import type { Member } from '../commands/fixture.ts';
import { addressFor, as, c, linkIn, send, w } from './c39-t-world.ts';

/** A gate a schedule holds closed until it lets the waiting side on. */
export function latch(): { readonly opened: Promise<void>; open: () => void } {
  const gate = { opened: Promise.resolve(), open: (): void => {} };
  gate.opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return gate;
}

/** Invite, send, and the token the mail carried. */
export async function invited(
  who: Member = c.admin,
  role = 'member',
  business: string = w.alpha,
): Promise<{ id: string; token: string; address: string }> {
  const address = addressFor('joiner');
  const result = await as(who, 'invitation.create', { name: 'Jo Joiner', email: address, role });
  const id = String((result as { recordId?: unknown }).recordId);
  expect(await send(id, business)).toMatchObject({ ok: true });
  return { id, token: linkIn(w.provider.outbox.at(-1)?.body).token, address };
}

export async function one<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[],
): Promise<T> {
  const [row] = await w.db.admin.execute<T>(sql, values);
  return row as T;
}

/** What an accept writes, counted for one invitation's person. */
export async function seated(invitationId: string): Promise<Record<string, unknown>> {
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

export const NOTHING = { spent: 0, actors: 0, memberships: 0, logins: 0, grants: 0, owed: 0 };
