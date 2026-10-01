// SPDX-License-Identifier: AGPL-3.0-only
//
// C23, the signed-in person menu: the server half. `session.end` is the command
// that causes `session ended (sign-out)`, under `account:write` on the caller's
// own account only; `session.person` is the name the menu shows. One describe
// per line of the ticket this proves, each on a fresh database through the
// real envelope and the real read dispatch.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import { declarationOf } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

// Sequential on purpose: each refused body is read back before the next.
// oxlint-disable no-await-in-loop

// eslint-disable-next-line max-lines-per-function -- one database, the ticket's lines
describe.skipIf(serverUrl === undefined)('C23 session.end and session.person', () => {
  let db: FreshDatabase;
  let alpha: string;
  /** A member holding every task grant. */
  let mia: Member;
  /** A member holding nothing at all. */
  let ned: Member;
  /** A client outside the business, standing on one shared task. */
  let client: Member;

  const end = async (who: Member, extra: Record<string, unknown> = {}) =>
    await executeCommand(db.app, alpha, who.presented, 'api', {
      command: 'session.end',
      operationId: randomUUID(),
      ...extra,
    } as never);

  const person = async (who: Member) =>
    await executeRead(db.app, alpha, who.presented, {
      read: 'session.person',
    } as unknown as ReadRequest);

  const ended = async (actorId: string) =>
    await db.app.withBusiness(alpha, async (tx) =>
      (await readAuditEvents(tx)).filter(
        (event) => event.command === 'session.end' && event.actor_id === actorId,
      ),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'c23end' });
    alpha = await insertBusiness(db.app, 'alpha');
    await installSpine(db.app, alpha);
    mia = await enrol(db.app, alpha, 'Mia Hart');
    ned = await enrol(db.app, alpha, 'Ned Bloom');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, mia, 'read');
      await grantTo(tx, mia, 'write');
      await grantTo(tx, mia, 'share');
    });
    const made = await executeCommand(db.app, alpha, mia.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'Shared brochure' },
    } as never);
    if (isCommandRefusal(made) || made.recordId === null) throw new Error('task.create refused');
    client = await shareWithClient(db.app, alpha, mia, made.recordId);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('C23 the command that causes each tracked action writes it in the same transaction, and appends it to the audit chain', () => {
    it('session.end is declared a write on the account collection, own account only, never an agent’s', () => {
      const row = declarationOf('session.end');
      expect(row).toMatchObject({
        kind: 'write',
        collection: 'account',
        action: 'write',
        authorisedOn: 'self',
        agent: 'never',
        targetsExistingRecord: false,
      });
    });

    it('a sign-out is applied and its audited event is on the chain, naming the person who signed out', async () => {
      const answer = await end(mia);
      expect(isCommandRefusal(answer)).toBe(false);
      expect(answer).toMatchObject({ recordId: null, detail: { ended: 'sign-out' } });
      const events = await ended(mia.actorId);
      expect(events.map((event) => event.outcome)).toEqual(['applied']);
      expect(events[0]?.subject_record_id).toBeNull();
      const chain = await db.app.withBusiness(alpha, async (tx) => await verifyAuditChain(tx));
      expect(chain).toMatchObject({ intact: true, firstBreak: undefined });
    });
  });

  describe('C23 every change it makes is recorded, and the audited ones join the audit chain', () => {
    it('each sign-out is its own event, read back in order, the refused ones included', async () => {
      const before = (await ended(ned.actorId)).length;
      await end(ned);
      await end(ned, { personId: mia.personId });
      const events = await ended(ned.actorId);
      expect(events.slice(before).map((event) => event.outcome)).toEqual(['applied', 'refused']);
    });

    it('a member who holds no grant at all still signs out: account:write is every signed-in person’s', async () => {
      const answer = await end(ned);
      expect(isCommandRefusal(answer)).toBe(false);
    });

    it('a client outside the business signs out too, and the event names that client', async () => {
      const answer = await end(client);
      expect(isCommandRefusal(answer)).toBe(false);
      expect((await ended(client.actorId)).map((event) => event.outcome)).toContain('applied');
    });
  });

  describe('C23 account:write, own account only', () => {
    it('a body naming another person, actor or account is refused and ends nobody', async () => {
      const miaBefore = (await ended(mia.actorId)).length;
      for (const extra of [
        { personId: mia.personId },
        { actorId: mia.actorId },
        { accountId: mia.personId },
        { recordId: mia.personId },
      ]) {
        const answer = await end(ned, extra);
        expect(isCommandRefusal(answer), JSON.stringify(extra)).toBe(true);
        expect(JSON.stringify(answer)).not.toContain('Mia');
      }
      expect(await ended(mia.actorId)).toHaveLength(miaBefore);
    });
  });

  describe('C23 session.person: who is signed in, and nobody else', () => {
    it('answers the caller’s own name and nothing more', async () => {
      expect(await person(mia)).toEqual({ ok: true, person: { name: 'Mia Hart' } });
      expect(await person(ned)).toEqual({ ok: true, person: { name: 'Ned Bloom' } });
    });

    it('answers a client outside the business with that client’s own name', async () => {
      const answer = JSON.stringify(await person(client));
      expect(answer).toMatch(/"person":\{"name":"client-/u);
      expect(answer).not.toContain('Mia');
    });

    it('takes no operand: a body naming another person is refused, naming nobody', async () => {
      const answer = await executeRead(db.app, alpha, ned.presented, {
        read: 'session.person',
        personId: mia.personId,
      } as unknown as ReadRequest);
      expect(isCommandRefusal(answer)).toBe(true);
      expect(JSON.stringify(answer)).not.toContain('Mia');
    });
  });
});
