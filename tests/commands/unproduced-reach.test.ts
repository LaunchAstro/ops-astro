// SPDX-License-Identifier: AGPL-3.0-only
//
// Refusal codes the register listed as unproduced, reached by an ordinary
// caller through the command envelope.
//
// `tests/runtime/gate.test.ts` proves `GATE_EXPIRED` and
// `CHANGE_ROUNDS_EXHAUSTED` against L4's own modules, and the acceptance
// matrix meets `DELEGATION_EXCLUDES_OPERATION` over HTTP but not beside the
// register that listed it. The module cases do not say a caller holding
// nothing but a login and a request body can meet the first two. The cases here are that: a person through
// `executeCommand`, an agent through `executeAgentCommand`, the refusal code
// on the command result, and the audit row that records it.
//
// `LEASE_EXPIRED` is not here, and deliberately. The delegation a pickup
// mints expires at the lease's own instant, so by the time the lease has
// expired the agent's credential is refused `DELEGATION_NOT_LIVE` before the
// handback is reached, and every other way a lease stops being live either
// settles the delegation with it or raises the task's fence, which answers
// `LEASE_NOT_OWNED` first.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'commands/unproduced: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** Just past a one-second window, and no longer: the database clock decides. */
const PAST_ONE_SECOND_MS = 1_250;

const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';
const detailOf = (result: CommandResult): Record<string, unknown> =>
  isCommandRefusal(result) ? {} : (result.detail as Record<string, unknown>);

describe.skipIf(serverUrl === undefined)(
  'the unproduced refusals, reached through commands',
  () => {
    let db: FreshDatabase;
    let business: BusinessId;
    let decider: Member;
    let agent: VerifiedSubject;
    let agentActorId: string;

    beforeAll(async () => {
      process.env['GATE_SIGNING_KEY_ID'] = 'test/unproduced-reach@1';
      process.env['GATE_SIGNING_SECRET'] = randomUUID();
      db = await createFreshDatabase({ part: 'u' });
      business = (await insertBusiness(db.app, 'unproduced-reach')) as BusinessId;
      await installSpine(db.app, business);
      decider = await enrol(db.app, business, 'decider');
      await db.app.withBusiness(business, async (tx) => {
        for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
          // Sequential: `issueGrant` reads the granter's own rows.
          // eslint-disable-next-line no-await-in-loop
          await grantTo(tx, decider, action);
        }
        await tx.query(
          `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 500000, 'AUD')`,
          [business, randomUUID()],
        );
        // The agent identity as `agent-path.test.ts` installs it: an `agent`
        // actor, a login of its own, and a mapping in `actor_logins` only.
        agentActorId = randomUUID();
        await tx.query(
          `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
          [business, agentActorId],
        );
        const subject = `agent-${randomUUID()}`;
        const loginId = await insertLogin(tx, subject);
        await tx.query(
          `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
          [business, randomUUID(), loginId, agentActorId, decider.actorId],
        );
        agent = { provider: 'supabase', subject };
      });
    }, 90_000);

    afterAll(async () => {
      await db?.drop();
    });

    const asPerson = async (body: Readonly<Record<string, unknown>>): Promise<CommandResult> =>
      await executeCommand(db.app, business, decider.presented, 'api', body as never);

    const asAgent = async (
      body: Readonly<Record<string, unknown>>,
      credential?: string,
    ): Promise<CommandResult> =>
      (await executeAgentCommand(
        db.app,
        business,
        agent,
        credential,
        body as never,
      )) as CommandResult;

    async function createTask(title: string): Promise<string> {
      const outcome = await asPerson({
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title },
      });
      if (isCommandRefusal(outcome) || outcome.recordId === null) throw new Error('no task');
      return outcome.recordId;
    }

    async function revisionOf(recordId: string): Promise<number> {
      const rows = await db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where business_id = $1 and id = $2`,
        [business, recordId],
      );
      return Number(rows[0]?.revision ?? '0');
    }

    async function proposeOn(
      recordId: string,
      options: { readonly lineageId?: string; readonly expiresInSeconds?: number } = {},
    ): Promise<Record<string, unknown>> {
      const outcome = await asPerson({
        command: 'task.propose',
        operationId: randomUUID(),
        recordId,
        expectedRevision: await revisionOf(recordId),
        purpose: 'draft_the_reply',
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'draft a reply to the client' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
        ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
        ...(options.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: options.expiresInSeconds }),
      });
      if (isCommandRefusal(outcome)) throw new Error(`task.propose refused ${outcome.code}`);
      return detailOf(outcome);
    }

    async function decideOn(
      proposal: Record<string, unknown>,
      decision: 'approve' | 'reject' | 'request_changes',
      operationId: string = randomUUID(),
    ): Promise<CommandResult> {
      return await asPerson({
        command: 'task.decide',
        operationId,
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision,
        note: `${decision} through the envelope`,
      });
    }

    async function auditFor(operationId: string) {
      return await db.app.withBusiness(business, async (tx) => {
        const events = await readAuditEvents(tx);
        return events.filter((event) => event.operation_id === operationId);
      });
    }

    async function decisionsOn(gateId: unknown): Promise<number> {
      const rows = await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.gate_decisions where business_id = $1 and gate_id = $2`,
        [business, gateId],
      );
      return Number(rows[0]?.n ?? '0');
    }

    it('refuses GATE_EXPIRED to a person approving a gate whose window has closed', async () => {
      const subject = await createTask('a proposal nobody decided in time');
      // One second is the shortest window the command accepts, and the server
      // turns it into an instant; the caller never names the instant itself.
      const proposal = await proposeOn(subject, { expiresInSeconds: 1 });
      await sleep(PAST_ONE_SECOND_MS);

      const operationId = randomUUID();
      const outcome = await decideOn(proposal, 'approve', operationId);
      expect(codeOf(outcome)).toBe('GATE_EXPIRED');

      // Expiry never becomes approval: no decision stands on the gate, and
      // nothing was reserved against the task.
      expect(await decisionsOn(proposal['gateId'])).toBe(0);
      const reservations = await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.reservations res
         join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
        where res.business_id = $1 and run.lineage_id = $2`,
        [business, proposal['lineageId']],
      );
      expect(Number(reservations[0]?.n)).toBe(0);

      const events = await auditFor(operationId);
      expect(events).toHaveLength(1);
      expect(events[0]?.outcome).toBe('refused');
      expect(events[0]?.refusal_code).toBe('GATE_EXPIRED');
    }, 20_000);

    it('refuses CHANGE_ROUNDS_EXHAUSTED to the third request for changes on one lineage', async () => {
      const subject = await createTask('a proposal sent back three times');
      const one = await proposeOn(subject);
      expect(codeOf(await decideOn(one, 'request_changes'))).toBe('not-a-refusal');

      // Each round is a new version on the same lineage, with its own gate.
      const lineageId = String(one['lineageId']);
      const two = await proposeOn(subject, { lineageId });
      expect(two['version']).toBe(2);
      expect(codeOf(await decideOn(two, 'request_changes'))).toBe('not-a-refusal');

      const three = await proposeOn(subject, { lineageId });
      expect(three['version']).toBe(3);

      const operationId = randomUUID();
      const outcome = await decideOn(three, 'request_changes', operationId);
      expect(codeOf(outcome)).toBe('CHANGE_ROUNDS_EXHAUSTED');

      // Exactly the two formal rounds are recorded; the refused third is not a
      // decision, and the third gate is still open to approve or reject.
      const rounds = await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.gate_decisions
        where business_id = $1 and lineage_id = $2 and decision = 'request_changes'`,
        [business, lineageId],
      );
      expect(Number(rounds[0]?.n)).toBe(2);
      expect(await decisionsOn(three['gateId'])).toBe(0);

      const events = await auditFor(operationId);
      expect(events).toHaveLength(1);
      expect(events[0]?.outcome).toBe('refused');
      expect(events[0]?.refusal_code).toBe('CHANGE_ROUNDS_EXHAUSTED');
    });

    it('refuses DELEGATION_EXCLUDES_OPERATION to an agent holding a live delegation', async () => {
      const subject = await createTask('the task an agent was handed');
      const proposal = await proposeOn(subject);
      const decided = await decideOn(proposal, 'approve');
      expect(codeOf(decided)).toBe('not-a-refusal');

      const pickedUp = await asAgent({
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: String(detailOf(decided)['reservationId']),
      });
      expect(codeOf(pickedUp)).toBe('not-a-refusal');
      const picked = detailOf(pickedUp);
      const credential = String(picked['credential']);

      // The credential is live: a read of its own task passes.
      const read = await asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: subject },
        credential,
      );
      expect(codeOf(read)).toBe('not-a-refusal');

      // Two operations a person may call and an agent may not reach at all,
      // however live its delegation.
      const before = await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.records where business_id = $1`,
        [business],
      );
      for (const body of [
        { command: 'task.create', fields: { title: 'an agent making its own work' } },
        { command: 'task.assign', recordId: subject, assigneeActorId: agentActorId },
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await asAgent({ ...body, operationId: randomUUID() }, credential);
        expect(codeOf(outcome), body.command).toBe('DELEGATION_EXCLUDES_OPERATION');
      }
      const after = await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.records where business_id = $1`,
        [business],
      );
      expect(after[0]?.n).toBe(before[0]?.n);

      // Refused before the register is consulted, so the audit row carries no
      // operation identity; it is the agent's own, under the command it tried.
      const events = await db.app.withBusiness(business, async (tx) => {
        const all = await readAuditEvents(tx);
        return all.filter(
          (event) =>
            event.actor_id === agentActorId &&
            event.refusal_code === 'DELEGATION_EXCLUDES_OPERATION',
        );
      });
      expect(events.map((event) => event.command)).toStrictEqual(['task.create', 'task.assign']);
      expect(events.every((event) => event.outcome === 'refused')).toBe(true);
      expect(events.every((event) => event.operation_id === null)).toBe(true);

      // Settle it, so the agent leaves this case holding nothing.
      await asAgent(
        {
          command: 'task.handback',
          operationId: randomUUID(),
          leaseId: String(picked['leaseId']),
          fence: Number(picked['fence']),
          outcome: 'completed',
        },
        credential,
      );
    });
  },
);
