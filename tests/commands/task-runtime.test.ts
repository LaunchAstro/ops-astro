// SPDX-License-Identifier: AGPL-3.0-only
//
// The four operations that used to refuse, through the command envelope.
//
// `tests/runtime/gate.test.ts` and `lease.test.ts` prove L4's mechanisms
// against L4's modules. Nothing in them goes through `executeCommand`, so
// nothing in them proves the four things L3 owes and L4 deliberately does not
// provide: the repeat-request identity, the audit row for every success and
// every refusal, the rollback of a refusal, and the exact-version decision a
// caller makes from what a read showed them. Those are the cases here, and
// every one of them is a real HTTP-shaped request through the real envelope.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'commands/runtime: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const CAP_LIMIT_MINOR = 100_000;

describe.skipIf(serverUrl === undefined)('propose and decide through the command envelope', () => {
  let db: FreshDatabase;
  let business: BusinessId;
  let decider: Member;
  let task: string;

  beforeAll(async () => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/command-envelope@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    db = await createFreshDatabase({ part: 'r' });
    business = (await insertBusiness(db.app, 'runtime-commands')) as BusinessId;
    await installSpine(db.app, business);
    decider = await enrol(db.app, business, 'decider');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // Sequential: `issueGrant` reads the granter's own rows, so two at once
        // would interleave those reads.
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, decider, action);
      }
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', $3, 'AUD')`,
        [business, randomUUID(), CAP_LIMIT_MINOR],
      );
    });
    task = await createTask('a task to propose against');
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function createTask(title: string): Promise<string> {
    const outcome = await call({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    });
    if (isCommandRefusal(outcome)) throw new Error(`task.create refused ${outcome.code}`);
    if (outcome.recordId === null) throw new Error('task.create returned no record');
    return outcome.recordId;
  }

  async function call(body: Readonly<Record<string, unknown>>): Promise<CommandResult> {
    return await executeCommand(db.app, business, decider.presented, 'api', body as never);
  }

  async function revisionOf(recordId: string): Promise<number> {
    const detail = (await executeRead(db.app, business, decider.presented, {
      read: 'task.read',
      recordId,
    })) as unknown as { readonly task: { readonly revision: number } };
    return detail.task.revision;
  }

  async function proposeOn(
    recordId: string,
    options: { readonly lineageId?: string; readonly maximumMinor?: number } = {},
  ): Promise<Record<string, string>> {
    const outcome = await call({
      command: 'task.propose',
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revisionOf(recordId),
      purpose: 'draft_the_reply',
      maximumMinor: options.maximumMinor ?? 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply to the client' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
      ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
    });
    if (isCommandRefusal(outcome)) throw new Error(`task.propose refused ${outcome.code}`);
    return outcome.detail as Record<string, string>;
  }

  async function auditFor(operationId: string) {
    return await db.app.withBusiness(business, async (tx) => {
      const events = await readAuditEvents(tx);
      return events.filter((event) => event.operation_id === operationId);
    });
  }

  async function countRows(table: string): Promise<number> {
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.${table} where business_id = $1`,
      [business],
    );
    return Number(rows[0]?.n ?? '0');
  }

  it('makes a real proposal and audits it as applied', async () => {
    const operationId = randomUUID();
    const outcome = await call({
      command: 'task.propose',
      operationId,
      recordId: task,
      expectedRevision: await revisionOf(task),
      purpose: 'draft_the_reply',
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    expect(isCommandRefusal(outcome)).toBe(false);
    if (isCommandRefusal(outcome)) throw new Error('unreachable');
    const detail = outcome.detail as Record<string, unknown>;
    expect(detail['lineageId']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(detail['version']).toBe(1);
    expect(detail['payloadDigest']).toHaveLength(64);

    const events = await auditFor(operationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('applied');
    expect(events[0]?.command).toBe('task.propose');
  });

  it('replays a proposal submitted twice under one identity rather than opening a second lineage', async () => {
    const other = await createTask('a task proposed against twice');
    const operationId = randomUUID();
    const body = {
      command: 'task.propose',
      operationId,
      recordId: other,
      expectedRevision: await revisionOf(other),
      purpose: 'draft_the_reply',
      maximumMinor: 1_000,
      currency: 'AUD',
      payload: { instruction: 'once' },
      step: { kind: 'compose', payload: {} },
    };
    const first = await call(body);
    const again = await call(body);
    expect(again).toStrictEqual(first);

    const lineages = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.proposal_lineages
        where business_id = $1 and task_id = $2`,
      [business, other],
    );
    expect(Number(lineages[0]?.n)).toBe(1);

    const events = await auditFor(operationId);
    expect(events.map((event) => event.outcome)).toStrictEqual(['applied', 'replayed']);
  });

  it('approves the exact version, reserves the work and puts it on the queue', async () => {
    const subject = await createTask('a task to approve');
    const proposal = await proposeOn(subject);
    const operationId = randomUUID();
    const outcome = await call({
      command: 'task.decide',
      operationId,
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'go ahead',
    });
    expect(isCommandRefusal(outcome)).toBe(false);
    if (isCommandRefusal(outcome)) throw new Error('unreachable');
    const detail = outcome.detail as Record<string, unknown>;
    expect(detail['decision']).toBe('approve');
    expect(detail['reservationId']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(detail['heldMinor']).toBe(2_500);

    const events = await auditFor(operationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('applied');

    const queued = (await executeRead(db.app, business, decider.presented, {
      read: 'task.queue',
    })) as unknown as { readonly queue: readonly Record<string, unknown>[] };
    expect(queued.queue.map((entry) => entry['reservationId'])).toContain(detail['reservationId']);
    expect(queued.queue.find((entry) => entry['taskId'] === subject)?.['purpose']).toBe(
      'draft_the_reply',
    );
  });

  it('refuses a decision on a superseded version and rolls the whole attempt back', async () => {
    const subject = await createTask('a task proposed against twice over');
    const first = await proposeOn(subject);
    const second = await proposeOn(subject, { lineageId: first['lineageId'] ?? '' });

    const before = {
      decisions: await countRows('gate_decisions'),
      envelopes: await countRows('task_envelopes'),
      reservations: await countRows('reservations'),
      attempts: await countRows('attempts'),
    };

    const operationId = randomUUID();
    const outcome = await call({
      command: 'task.decide',
      operationId,
      // The live gate, named with the version this caller read before the
      // second proposal landed. The gate is right and the version is stale,
      // which is the case `decide` compares for and never trusts.
      gateId: second['gateId'],
      versionId: first['versionId'],
      decision: 'approve',
      note: 'deciding what I read a moment ago',
    });
    expect(isCommandRefusal(outcome)).toBe(true);
    expect(isCommandRefusal(outcome) ? outcome.code : '').toBe('VERSION_SUPERSEDED');

    // Nothing the handler touched survived the refusal. A refusal that still
    // moved a total would pass the assertion above and fail these four.
    expect({
      decisions: await countRows('gate_decisions'),
      envelopes: await countRows('task_envelopes'),
      reservations: await countRows('reservations'),
      attempts: await countRows('attempts'),
    }).toStrictEqual(before);

    const events = await auditFor(operationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('refused');
    expect(events[0]?.refusal_code).toBe('VERSION_SUPERSEDED');
  });

  it('records the loser of a decision race as a refused attempt (G03)', async () => {
    const subject = await createTask('a task two people decide');
    const proposal = await proposeOn(subject);
    const winner = await call({
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'first',
    });
    expect(isCommandRefusal(winner)).toBe(false);

    const loserOperationId = randomUUID();
    const loser = await call({
      command: 'task.decide',
      operationId: loserOperationId,
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'reject',
      note: 'second',
    });
    expect(isCommandRefusal(loser)).toBe(true);
    expect(isCommandRefusal(loser) ? loser.code : '').toBe('GATE_ALREADY_DECIDED');

    // The refusal is on the trail, which is what G03 asks L3 for: L4 returns
    // the refusal and writes nothing, so a loser with no audit row would be a
    // decision attempt nobody can see happened.
    const events = await auditFor(loserOperationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('refused');
    expect(events[0]?.refusal_code).toBe('GATE_ALREADY_DECIDED');

    // And exactly one decision stands on that gate.
    const decisions = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.gate_decisions where business_id = $1 and gate_id = $2`,
      [business, proposal['gateId']],
    );
    expect(Number(decisions[0]?.n)).toBe(1);
  });

  it('shows a task page the stored version, its evidence, the gate and the decision chain', async () => {
    const subject = await createTask('a task with something to show');
    const proposal = await proposeOn(subject);
    await call({
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approved for the projection',
    });

    const detail = (await executeRead(db.app, business, decider.presented, {
      read: 'task.read',
      recordId: subject,
    })) as unknown as {
      readonly task: { readonly proposals: readonly Record<string, never>[] };
    };
    expect(detail.task.proposals).toHaveLength(1);
    const view = detail.task.proposals[0] as unknown as {
      readonly lineageId: string;
      readonly state: string;
      readonly versions: readonly Record<string, unknown>[];
      readonly decisions: readonly Record<string, unknown>[];
      readonly reservations: readonly Record<string, unknown>[];
    };
    expect(view.lineageId).toBe(proposal['lineageId']);
    expect(view.state).toBe('live');

    const version = view.versions[0] as unknown as {
      readonly versionId: string;
      readonly version: number;
      readonly payloadDigest: string;
      readonly maximumMinor: number;
      readonly evidence: { readonly renderer: string; readonly digest: string } | null;
      readonly gate: { readonly state: string; readonly expiresAt: string } | null;
    };
    // The exact version the decision control has to carry, beside the evidence
    // the person is deciding on.
    expect(version.versionId).toBe(proposal['versionId']);
    expect(version.version).toBe(1);
    expect(version.payloadDigest).toBe(proposal['payloadDigest']);
    expect(version.maximumMinor).toBe(2_500);
    expect(version.evidence?.renderer).toBe('core-runtime/evidence@1');
    expect(version.evidence?.digest).toHaveLength(64);
    expect(version.gate?.state).toBe('approved');
    expect(Date.parse(version.gate?.expiresAt ?? '')).toBeGreaterThan(Date.now());

    // The chain as stored, hash and all, so a reader can check it rather than
    // trust a summary of it.
    expect(view.decisions).toHaveLength(1);
    expect(view.decisions[0]?.['decision']).toBe('approve');
    expect(String(view.decisions[0]?.['hash'])).toHaveLength(64);
    expect(String(view.decisions[0]?.['prevHash'])).toHaveLength(64);

    expect(view.reservations).toHaveLength(1);
    expect(view.reservations[0]?.['state']).toBe('held');
    expect(view.reservations[0]?.['heldMinor']).toBe(2_500);
    expect(view.reservations[0]?.['lease']).toBeNull();
    const attempt = view.reservations[0]?.['attempt'] as { readonly state: string } | undefined;
    expect(attempt?.state).toBe('reserved');
  });

  it('refuses a person who tries to pick work up, because a pickup mints an agent a delegation', async () => {
    const operationId = randomUUID();
    const outcome = await call({
      command: 'task.pickup',
      operationId,
      reservationId: randomUUID(),
    });
    expect(isCommandRefusal(outcome)).toBe(true);
    expect(isCommandRefusal(outcome) ? outcome.code : '').toBe('AUTH_NO_AGENT_IDENTITY');
    const events = await auditFor(operationId);
    expect(events[0]?.refusal_code).toBe('AUTH_NO_AGENT_IDENTITY');
  });
});
