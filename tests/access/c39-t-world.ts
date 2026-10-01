// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the C39-T invitation cases share, one per test file: AW-07b's
// email world (two businesses, the fake provider on loopback, custody holding
// the mail credential, a broker over them), and in it the people C39-T needs.
// In alpha: an administrator holding `access:share` on the whole business, a
// second one, a member holding none, and a person holding `access:share` on
// one client only. In bravo: its own administrator.

import { randomUUID } from 'node:crypto';
import { beforeAll } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  sendInvitation,
  type InvitationSendResult,
} from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { MAIL, useEmailWorld, w } from '../broker/email-world.ts';

export { MAIL, w };
export { noDatabase } from '../broker/email-world.ts';

export interface InvitationCast {
  admin: Member;
  second: Member;
  member: Member;
  /** Holds `access:share` on one client of alpha, never on the business. */
  clientSharer: Member;
  clientA: string;
  bravoAdmin: Member;
}

export const c = {} as InvitationCast;

/** The email world, then the cast. */
export function useInvitationWorld(): void {
  useEmailWorld();
  beforeAll(async () => {
    c.admin = await enrol(w.db.app, w.alpha, 'Avery Admin');
    c.second = await enrol(w.db.app, w.alpha, 'Sam Second');
    c.member = await enrol(w.db.app, w.alpha, 'Mo Member');
    c.clientSharer = await enrol(w.db.app, w.alpha, 'Cleo Client Lead');
    c.bravoAdmin = await enrol(w.db.app, w.bravo, 'Bea Bravo');
    c.clientA = randomUUID();
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, c.admin, 'share', undefined, false, 'access');
      await grantTo(tx, c.second, 'share', undefined, false, 'access');
      await grantTo(tx, c.member, 'read');
      await grantTo(tx, c.clientSharer, 'share', { kind: 'party', id: c.clientA }, false, 'access');
    });
    await w.db.app.withBusiness(w.bravo, async (tx) => {
      await grantTo(tx, c.bravoAdmin, 'share', undefined, false, 'access');
    });
  }, 120_000);
}

/** Which business a cast member belongs to. */
const businessOf = (who: Member): string => (who === c.bravoAdmin ? w.bravo : w.alpha);

/** One command as a person, through the person envelope. */
export async function as(
  who: Member,
  command: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<CommandResult> {
  return await executeCommand(w.db.app, businessOf(who), who.presented, 'api', {
    command,
    operationId: randomUUID(),
    ...body,
  } as never);
}

/** A unique address under the test domain. */
export const addressFor = (name: string): string =>
  `${name}-${randomUUID().slice(0, 8)}@team.example.test`;

/** Invite, and the new invitation's id; a refusal throws naming its code. */
export async function invite(
  who: Member,
  address: string = addressFor('invitee'),
  role = 'member',
): Promise<string> {
  const result = await as(who, 'invitation.create', { name: 'Ivy Invitee', email: address, role });
  if (isCommandRefusal(result)) throw new Error(`invite refused ${result.code}`);
  return String(result.recordId);
}

/** The send after an act, as the person path makes it. */
export async function send(
  invitationId: string,
  business: string = w.alpha,
): Promise<InvitationSendResult> {
  return await sendInvitation(w.db.app, business, invitationId, w.broker, MAIL);
}

/** The code a result answered with: `applied`, or the refusal's code. */
export const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'applied';

/** One invitation as the database holds it, read as the owner. */
export async function invitationRow(id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await w.db.admin.execute<Record<string, unknown>>(
    `select business_id, person_id, role_key, address, state, revision, created_by_actor_id,
            expires_at, ended_at
       from public.invitations where id = $1`,
    [id],
  );
  return row;
}

/** Every audit event naming a subject, oldest first. */
export async function auditOf(
  subject: string,
): Promise<readonly { command: string; outcome: string; actor_id: string }[]> {
  return await w.db.admin.execute<{ command: string; outcome: string; actor_id: string }>(
    `select command, outcome, actor_id from public.audit_events
      where subject_record_id = $1 order by seq`,
    [subject],
  );
}

/** How many rows a table holds for one invitation. */
export async function countFor(
  table: 'enrolment_tokens' | 'invitation_delivery_attempts',
  invitationId: string,
): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.${table} where invitation_id = $1`,
    [invitationId],
  );
  return Number(row?.n);
}

/** The one link an accepted message carries, and the token at its end. */
export function linkIn(body: string | undefined): { link: string; token: string } {
  const text = String((JSON.parse(body ?? '{}') as Record<string, unknown>)['text']);
  const link = /https:\/\/\S+/u.exec(text)?.[0] ?? '';
  return { link, token: link.slice(`${MAIL.appOrigin}/enrol/`.length) };
}

/** Every row that could carry a value, as text, from the tables an invitation touches. */
export async function storedText(): Promise<string> {
  const tables = [
    'audit_events',
    'operations',
    'invitations',
    'enrolment_tokens',
    'invitation_delivery_attempts',
  ];
  const parts = await Promise.all(
    tables.map(
      async (table) =>
        await w.db.admin.execute<{ t: string }>(
          `select coalesce(string_agg(to_jsonb(x)::text, ' '), '') as t from public.${table} x`,
        ),
    ),
  );
  return parts.map((rows) => rows[0]?.t ?? '').join(' ');
}

/** How many people a business holds. */
export async function peopleIn(business: string): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.people where business_id = $1',
    [business],
  );
  return Number(row?.n);
}

/** How many requests the fake provider has received. */
export const received = (): number => w.provider.received.length;
