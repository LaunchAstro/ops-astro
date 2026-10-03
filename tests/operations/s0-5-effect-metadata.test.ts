// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved rather than trusted: every command in the
// catalogue is run once on its positive fixture (the role-case harness's
// recipes), and the tables whose rows changed are compared with the record
// kinds it declares. An undeclared write fails; so does a kind declared
// business-internal whose table reaches a task or a client through its
// foreign keys, since a row holding a task's id is a client-scoped write.
// The act's own bookkeeping (its audit event, its operation row, the bearer's
// verification and the live change record) is the same for every call and is
// not a record kind.
// A declared kind that is no table fails too, so a misspelt one cannot pass. Two commands have no
// recipe of their own (a grant id, a live delegation) and get one here.
// A path a positive fixture misses (SEC3BFINAL) is run on its own and must
// write nothing undeclared; the money paths are `s0-5-effect-money-paths`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-wire/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { PROPOSAL, type Prepared } from '../acceptance/role-case-bodies.ts';
import { serverUrl } from '../acceptance/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  changed,
  fingerprint,
  pathFaults,
  undeclared,
  type EffectPath,
} from './s0-5-effect-diff.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-effect-metadata: DATABASE_URL is unset, so nothing below ran.');
}

/** Commands no person path reaches, so this person-path proof cannot run them. */
const AGENT_ONLY: ReadonlySet<string> = new Set([
  'model.call',
  'run.delegate_child',
  'run.child_handback',
]);

let harness: Harness;

/** Tables that reach `records` (tasks) or `clients` through their foreign keys. */
async function clientScoped(): Promise<ReadonlySet<string>> {
  const rows = await harness.world.db.admin.execute<{ readonly name: string }>(
    `with recursive fk as (
       select distinct c.relname as t, r.relname as ref
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
         join pg_class r on r.oid = k.confrelid
         join pg_namespace n on n.oid = c.relnamespace
        where k.contype = 'f' and n.nspname = 'public' and c.relname <> r.relname
     ), reach(t) as (
       select 'records'::name union select 'clients'::name
       union select fk.t from fk join reach on fk.ref = reach.t
     )
     select t::text as name from reach`,
  );
  return new Set(rows.map((row) => row.name));
}

/** The positive recipe, or one made here where it changes nothing or there is none. */
async function bodyFor(declaration: CommandDeclaration): Promise<Prepared> {
  if (declaration.name === 'grant.revoke') {
    const mia = harness.world.mia as unknown as Member;
    const grantId = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) => await grantTo(tx, mia, 'comment'),
    );
    return { body: { grantId } };
  }
  if (declaration.name === 'access.grant') {
    // The recipe re-grants a key the member already holds; one client's is new.
    const made = await harness.asPerson('client.create', { name: `s0-5 effects ${randomUUID()}` });
    const clientId = (made.body['detail'] as Record<string, unknown>)['clientId'];
    const holderId = (harness.world.mia as unknown as Member).personId;
    return { body: { holderId, collection: 'task', action: 'read', clientId } };
  }
  if (declaration.name === 'delegation.revoke') {
    const task = await harness.freshTask(`s0-5 effects ${randomUUID()}`);
    const decided = await harness.reserve(task, 'draft_the_effects_reply');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    return {
      body: { delegationId: (picked.body['detail'] as Record<string, unknown>)['delegationId'] },
    };
  }
  if (declaration.name === 'task.revoke_client_share') {
    // The recipe revokes on a task never shared, which changes nothing: share one first.
    const share = COMMAND_SURFACE.find((one) => one.name === 'task.share_with_client');
    if (share === undefined) throw new Error('task.share_with_client is not in the surface');
    const shared = await harness.positiveBody(share);
    if ('exception' in shared) return shared;
    const answer = await harness.asPerson('task.share_with_client', shared.body);
    if (answer.code !== 'ok') throw new Error(`share before revoke refused ${answer.code}`);
    return {
      body: { recordId: shared.body['recordId'], expectedRevision: answer.body['revision'] },
    };
  }
  return await harness.positiveBody(declaration);
}

/** What is wrong with a declaration before it runs: a kind that is no table, or scoped too narrowly. */
function declaredFaults(
  declaration: CommandDeclaration,
  tables: ReadonlySet<string>,
  scoped: ReadonlySet<string>,
): string[] {
  const { name } = declaration;
  return COMMAND_EFFECTS[name].writes.flatMap((kind) => [
    ...(tables.has(kind.kind) ? [] : [`${name}: declares ${kind.kind}, which is no table`]),
    ...(kind.scope === 'business' && scoped.has(kind.kind)
      ? [`${name}: declares ${kind.kind} business-internal; it reaches a task or client`]
      : []),
  ]);
}

/** Runs the command on its fixture and names every table it changed that it does not declare. */
async function runFaults(declaration: CommandDeclaration): Promise<string[]> {
  const { name } = declaration;
  const prepared = await bodyFor(declaration);
  // `model.call` and AW-11's child work answer on the agent prefix only; the person path this
  // proof drives refuses it by design, so its writes are not proved here
  // (batch 3a join; an agent-path proof is owed, SOL-OWED).
  if ('exception' in prepared && AGENT_ONLY.has(name)) return [];
  if ('exception' in prepared) return [`${name}: no fixture (${prepared.exception})`];
  const before = await fingerprint(harness.world.db.admin);
  const answer = await harness.asPerson(name, prepared.body);
  if (answer.code !== 'ok') return [`${name}: its fixture was refused ${answer.code}`];
  const written = changed(before, await fingerprint(harness.world.db.admin));
  return [
    ...(declaration.kind === 'write' && written.length === 0 && !(name in NO_CHANGE)
      ? [`${name}: its fixture changed no row, so its declaration is unproved`]
      : []),
    ...undeclared(name, written),
    ...(EXACT.has(name)
      ? COMMAND_EFFECTS[name].writes
          .filter(({ kind }) => !written.includes(kind) && !ON_A_PATH[name]?.includes(kind))
          .map(({ kind }) => `${name}: declares ${kind}, which its fixture did not write`)
      : []),
  ];
}

/**
 * Commands whose declaration is also proved the other way: every kind they
 * declare, their fixture writes, so a kind they never write is not claimed.
 * SL12's commands (batch 3a); each writes all it declares on its one path.
 */
const EXACT: ReadonlySet<string> = new Set([
  'task.check',
  'conversation.start',
  'conversation.message',
  'conversation.rename',
  'conversation.set_scope',
  'run.top_up',
  'run.end_at_budget_stop',
  'run.revise_state',
]);

/** An EXACT command's kind written only on a path its fixture misses, proved there. */
const ON_A_PATH: Readonly<Record<string, readonly string[]>> = {
  // At a hold its calls spent whole: `s0-5-effect-money-paths`.
  'run.top_up': ['attempts'],
};

/**
 * Write commands whose fixture changes no row, each with where its write is
 * proved instead. Any other write that changes nothing fails: its declaration
 * would be unproved.
 */
const NO_CHANGE: Readonly<Record<string, string>> = {
  'task.purge':
    'a fresh trash is inside the retention window; the purge is tests/commands/purge-retention.test.ts',
  'session.end':
    'a sign-out writes only its audit event; the browser ends the credential (tests/commands/c23-session-end.test.ts)',
  'notifications.set_channel':
    'in-app is always on and email waits on AW-07b, so nothing is stored yet (tests/commands/inbox-escalation-settings.test.ts)',
};

const detailOf = (answer: { readonly body: Record<string, unknown> }): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

/** The admin's own plan, approved and picked up (EX-01), and its handback with a successor (AW-08). */
async function ownPlanLease(): Promise<{
  readonly recordId: string;
  readonly lineageId: string;
  readonly handback: Record<string, unknown>;
}> {
  const task = await harness.freshTask(`s0-5 path ${randomUUID()}`);
  const proposed = await harness.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...PROPOSAL,
  });
  const { gateId, versionId, lineageId } = detailOf(proposed);
  const decided = await harness.asPerson('task.decide', {
    gateId,
    versionId,
    decision: 'approve',
    note: 'approved so its lease hands back',
  });
  const picked = detailOf(
    await harness.asPerson('task.pickup', { reservationId: detailOf(decided)['reservationId'] }),
  );
  const handback = {
    leaseId: picked['leaseId'],
    fence: picked['fence'],
    outcome: 'completed',
    report: { summary: 'the reviewed output' },
    successor: PROPOSAL,
  };
  return { recordId: task.id, lineageId: String(lineageId), handback };
}

const codeOf = async (name: CommandName, body: Record<string, unknown>): Promise<string> =>
  (await harness.asPerson(name, body)).code;

/** SEC3BFINAL L1 to L3: paths the positive fixtures miss, on the person's route. */
const PATHS: readonly EffectPath[] = [
  {
    // The proposal raised a decision item for the admin; the accept clears it.
    name: 'task.accept_plan',
    code: 'ok',
    drives: ['inbox_items'],
    prepare: async () => {
      const gate = await bodyFor(COMMAND_SURFACE.find((one) => one.name === 'task.accept_plan')!);
      if ('exception' in gate) throw new Error(gate.exception);
      return async () => await codeOf('task.accept_plan', gate.body);
    },
  },
  {
    // AW-08: the successor a handback writes is the reviewed output.
    name: 'task.handback',
    code: 'ok',
    drives: ['reviewed_outputs'],
    prepare: async () => {
      const { handback } = await ownPlanLease();
      return async () => await codeOf('task.handback', handback);
    },
  },
  {
    // AW-09: the lease holder's revision after requested changes is its output too.
    name: 'task.propose',
    code: 'ok',
    drives: ['reviewed_outputs'],
    prepare: async () => {
      const { recordId, lineageId, handback } = await ownPlanLease();
      const successor = detailOf(await harness.asPerson('task.handback', handback));
      const asked = await harness.asPerson('task.decide', {
        gateId: successor['successorGateId'],
        versionId: successor['successorVersionId'],
        decision: 'request_changes',
        note: 'revise it',
      });
      if (asked.code !== 'ok') throw new Error(`request changes refused ${asked.code}`);
      const read = await harness.asPerson('task.read', { recordId });
      const expectedRevision = (read.body['task'] as { revision: number }).revision;
      const body = { recordId, expectedRevision, ...PROPOSAL, lineageId };
      return async () => await codeOf('task.propose', body);
    },
  },
];

describe.skipIf(serverUrl === undefined)('S0-5 gate coverage: the effect metadata, proved', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_effects');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 gate coverage (proved): each command changes only the record kinds it declares, at no narrower scope', async () => {
    const scoped = await clientScoped();
    const tables = new Set((await fingerprint(harness.world.db.admin)).keys());
    const found: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      // One command at a time: the digest before and after must be this one's alone.
      // eslint-disable-next-line no-await-in-loop
      found.push(...declaredFaults(declaration, tables, scoped), ...(await runFaults(declaration)));
    }
    expect(found).toStrictEqual([]);
  }, 300_000);

  it.each(PATHS)(
    'S0-5 gate coverage (paths): $name, writing $drives, declares what it writes',
    async (path) => {
      expect(await pathFaults(harness.world.db.admin, path)).toStrictEqual([]);
    },
    120_000,
  );
});
