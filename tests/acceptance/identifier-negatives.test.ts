// SPDX-License-Identifier: AGPL-3.0-only
//
// Ledger rows I03 and I04 over every identifier-bearing operand, not only the
// task record the matrix's (c) and (d) cells swap. Each cell sends one operand
// in up to three forms (real in bravo, fabricated, and in alpha but outside
// the caller's reach) through the real HTTP boundary, and asks of each answer:
// the contract's code (minimum contract 8.2 case 1); the same status and body
// across the forms once the caller's own presented identifier is blanked
// (case 2); one refused audit row in alpha and none in bravo, digest only
// (case 1, I13); and both businesses' tenant tables unchanged (T1).
//
// The third form needs a caller whose reach stops short of its business:
// `rhea`, whose grants name one record, and the agent, whose delegation names
// one task. Another agent's lease is `DELEGATION_OUT_OF_PURPOSE` by design
// (`authority/delegations.ts:323-372` reads the purpose first), so that form is
// asserted on its own code. The last case is the target-free operations, for
// the SC2 reading TRANSACTION-CONTRACT line 113 proposes.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { READS } from '../../packages/core-records/src/commands/surface.ts';
import { PROPOSAL } from './role-case-bodies.ts';
import { serverUrl, type AgentIdentity, type Answer, type Caller } from './world.ts';
import {
  auditMark,
  auditSince,
  createIdentWorld,
  domainState,
  expectAudited,
  type IdentWorld,
} from './ident-audit-cases.ts';

type Body = Readonly<Record<string, unknown>>;

/** Who presents the operand: a person, or an agent with or without its credential. */
type Presenter =
  | { readonly kind: 'person'; readonly caller: Caller }
  | { readonly kind: 'agent'; readonly identity: AgentIdentity; readonly credential?: string };

interface Cell {
  readonly op: CommandName;
  readonly operand: string;
  readonly by: Presenter;
  readonly code: string;
  readonly forms: Readonly<Record<string, Body>>;
  /** A form whose answer is its own code rather than the shared one. */
  readonly apart?: Readonly<Record<string, string>>;
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** The body, with the identifiers this request presented blanked. */
function blanked(answer: Answer, sent: Body): string {
  const presented = new Set(JSON.stringify(sent).match(UUID_ANYWHERE) ?? []);
  return JSON.stringify(answer.body).replace(UUID_ANYWHERE, (id) =>
    presented.has(id) ? '<presented>' : id,
  );
}

const NOBODY = 'text nobody should find in an audit row';

/** An operand in its foreign and fabricated forms. */
const pair = (
  operand: string,
  foreignId: string,
  body: (id: string) => Body,
): { operand: string; forms: Readonly<Record<string, Body>> } => ({
  operand,
  forms: { foreign: body(foreignId), fabricated: body(randomUUID()) },
});

const actorOf = (by: Presenter): string =>
  by.kind === 'person' ? (by.caller.actorId as string) : by.identity.actorId;

describe.skipIf(serverUrl === undefined)('identifier negatives (I03, I04)', () => {
  let w: IdentWorld;
  let alpha: string;
  let bravo: string;
  let ada: Presenter;

  beforeAll(async () => {
    w = await createIdentWorld('ident_negatives');
    alpha = w.h.world.alpha;
    bravo = w.h.world.bravo;
    ada = { kind: 'person', caller: w.h.world.ada };
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  async function send(by: Presenter, op: CommandName, body: Body): Promise<Answer> {
    return by.kind === 'person'
      ? await w.person(by.caller, op, body)
      : await w.agent(by.identity, op, body, by.credential);
  }

  /** One cell: every form refused alike, audited at home, and nothing moved. */
  async function probe(cell: Cell): Promise<void> {
    const seen: { form: string; answer: Answer; body: Body }[] = [];
    for (const [form, shape] of Object.entries(cell.forms)) {
      const label = `${cell.op} ${cell.operand} ${form}`;
      const body = { operationId: randomUUID(), ...shape };
      /* eslint-disable no-await-in-loop -- each form against its own before and after */
      const before = await domainState(w.h, [alpha, bravo]);
      const mark = await auditMark(w.h);
      const answer = await send(cell.by, cell.op, body);
      const rows = await auditSince(w.h, mark);
      const after = await domainState(w.h, [alpha, bravo]);
      /* eslint-enable no-await-in-loop */
      const code = cell.apart?.[form] ?? cell.code;
      expect(answer.code, `${label}: ${JSON.stringify(answer.body)}`).toBe(code);
      expect(after, `${label}: durable state`).toStrictEqual(before);
      expectAudited(label, rows, {
        businessId: alpha,
        actorId: actorOf(cell.by),
        command: cell.op,
        // A person's read records no operation (`reads/dispatch.ts:83`); the
        // agent envelope records the identity of every call it settles.
        operationId: READS.includes(cell.op) && cell.by.kind === 'person' ? null : body.operationId,
        outcome: 'refused',
        refusalCode: code,
        body,
      });
      if (cell.apart?.[form] === undefined) seen.push({ form, answer, body });
    }
    const [first, ...rest] = seen;
    for (const other of rest) {
      const label = `${cell.op} ${cell.operand}: ${first?.form} against ${other.form}`;
      expect(other.answer.status, label).toBe(first?.answer.status);
      expect(blanked(other.answer, other.body), label).toBe(
        first === undefined ? '' : blanked(first.answer, first.body),
      );
    }
  }

  /** `probe`, spelled positionally for the table-shaped cases. */
  async function refuses(
    op: CommandName,
    operand: string,
    by: Presenter,
    code: string,
    forms: Readonly<Record<string, Body>>,
    apart?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await probe({ op, operand, by, code, forms, ...(apart === undefined ? {} : { apart }) });
  }

  /** A fresh alpha task, with a body writing against its current revision. */
  async function onFresh(extra: Body): Promise<Body> {
    const task = await w.h.freshTask('a task an operand is probed on');
    return { recordId: task.id, expectedRevision: task.revision, ...extra };
  }

  it('refuses a foreign and a fabricated task record alike, and audits at home', async () => {
    // Re-run from the matrix's (c) and (d) for what those do not assert: the
    // audit row, where it lands, the digest and the durable state.
    const targeted: readonly [CommandName, Body][] = [
      ['task.update', { fields: { title: NOBODY } }],
      ['task.complete', {}],
      ['task.reopen', { reason: NOBODY }],
      ['task.comment', { body: NOBODY, audience: 'internal' }],
      ['task.propose', { ...PROPOSAL, payload: { instruction: NOBODY } }],
      ['task.start', {}],
      ['task.assign', { fields: { assignee: w.h.world.mia.personId } }],
      ['task.triage', { fields: { intake_state: 'accepted' } }],
      ['task.set_stage', { fields: { stage: 'drafting' } }],
      ['task.set_party', { fields: { client: randomUUID() } }],
      ['task.set_audience', { fields: { client_visible: true } }],
      ['task.reparent', { parentId: null }],
      ['task.move', { board: null, boardSection: null }],
      ['task.rank', { afterId: w.h.alphaTask.id }],
      ['task.trash', {}],
    ];
    for (const [op, extra] of targeted) {
      // eslint-disable-next-line no-await-in-loop
      await refuses(op, 'recordId', ada, 'NOT_FOUND', {
        foreign: { recordId: w.foreign.task.id, expectedRevision: 1, ...extra },
        fabricated: { recordId: randomUUID(), expectedRevision: 1, ...extra },
      });
    }
    await refuses('task.read', 'recordId', ada, 'NOT_FOUND', {
      foreign: { recordId: w.foreign.task.id },
      fabricated: { recordId: randomUUID() },
    });
  }, 300_000);

  it('refuses rhea alike on a foreign, a fabricated and an unreached alpha record', async () => {
    // The scope check (`prepare.ts:291-300`) answers before any lookup could
    // tell the three apart. Her own record is the control, afterwards.
    const rhea: Presenter = { kind: 'person', caller: w.rhea };
    const unreached = await w.h.freshTask('an alpha task outside her grant');
    const forms = (extra: Body): Readonly<Record<string, Body>> => ({
      foreign: { recordId: w.foreign.task.id, expectedRevision: 1, ...extra },
      fabricated: { recordId: randomUUID(), expectedRevision: 1, ...extra },
      'same business': { recordId: unreached.id, expectedRevision: unreached.revision, ...extra },
    });
    const byAction: readonly [CommandName, Body][] = [
      ['task.update', { fields: { title: NOBODY } }],
      ['task.comment', { body: NOBODY, audience: 'internal' }],
      ['task.assign', { fields: { assignee: w.h.world.mia.personId } }],
      ['task.set_audience', { fields: { client_visible: true } }],
      ['task.trash', {}],
    ];
    for (const [op, extra] of byAction) {
      // eslint-disable-next-line no-await-in-loop
      await refuses(op, 'recordId', rhea, 'SCOPE_NOT_GRANTED', forms(extra));
    }
    await refuses('task.read', 'recordId', rhea, 'SCOPE_NOT_GRANTED', {
      foreign: { recordId: w.foreign.task.id },
      fabricated: { recordId: randomUUID() },
      'same business': { recordId: unreached.id },
    });

    const read = await w.person(w.rhea, 'task.read', { recordId: w.rheaTask.id });
    expect(read.code).toBe('ok');
    const edited = await w.person(w.rhea, 'task.update', {
      recordId: w.rheaTask.id,
      expectedRevision: w.rheaTask.revision,
      fields: { title: 'rhea edits her own task' },
    });
    expect(edited.code).toBe('ok');
    const commented = await w.person(w.rhea, 'task.comment', {
      recordId: w.rheaTask.id,
      expectedRevision: Number(edited.body['revision']),
      body: 'rhea comments on her own task',
      audience: 'internal',
    });
    expect(commented.code).toBe('ok');
  }, 300_000);

  it('refuses foreign and fabricated secondary identifiers alike', async () => {
    const task = w.foreign.task.id;
    const person = w.foreign.admin.personId as string;
    const cells: readonly [CommandName, string, string, (id: string) => Body][] = [
      ['task.move', 'board', task, (id) => ({ board: id, boardSection: null })],
      ['task.rank', 'afterId', task, (id) => ({ afterId: id })],
      ['task.rank', 'beforeId', task, (id) => ({ beforeId: id })],
      ['task.reparent', 'parentId', task, (id) => ({ parentId: id })],
      ['task.assign', 'assignee', person, (id) => ({ fields: { assignee: id } })],
    ];
    for (const [op, operand, foreignId, shape] of cells) {
      /* eslint-disable no-await-in-loop -- a fresh target per form */
      const forms = {
        foreign: await onFresh(shape(foreignId)),
        fabricated: await onFresh(shape(randomUUID())),
      };
      await refuses(op, operand, ada, 'NOT_FOUND', forms);
      /* eslint-enable no-await-in-loop */
    }
  }, 300_000);

  it('refuses foreign and fabricated control identifiers alike', async () => {
    const own = await w.propose('a lineage of alpha’s own');
    const f = w.foreign;
    const lineage = (recordId: string, lineageId: string, op: CommandName): Body =>
      op === 'task.cancel' ? { recordId, lineageId, reason: NOBODY } : { recordId, lineageId };
    const cells: [CommandName, ReturnType<typeof pair>][] = [];
    for (const op of ['task.cancel', 'task.restart'] as const) {
      cells.push(
        [op, pair('lineageId', f.proposal.lineageId, (id) => lineage(own.task.id, id, op))],
        [op, pair('recordId', f.proposal.task.id, (id) => lineage(id, own.lineageId, op))],
      );
    }
    cells.push(
      ['task.restore', pair('batchId', f.batchId, (batchId) => ({ batchId }))],
      ['grant.revoke', pair('grantId', f.grantId, (grantId) => ({ grantId }))],
      [
        'delegation.revoke',
        pair('delegationId', f.picked.delegationId, (delegationId) => ({ delegationId })),
      ],
    );
    for (const [op, { operand, forms }] of cells) {
      // eslint-disable-next-line no-await-in-loop
      await refuses(op, operand, ada, 'NOT_FOUND', forms);
    }
  }, 300_000);

  it('refuses a foreign and a fabricated gate NOT_FOUND, as contract 8.2 case 1 names it', async () => {
    // RED at 74d583c: `task.decide` answers `GATE_NOT_FOUND`, a code case 1
    // does not name for a foreign gate identifier. The two forms are still
    // indistinguishable once the presented gate is blanked.
    const decision = { decision: 'approve', note: NOBODY };
    const { gateId, versionId } = w.foreign.proposal;
    await refuses('task.decide', 'gateId', ada, 'NOT_FOUND', {
      foreign: { gateId, versionId, ...decision },
      fabricated: { gateId: randomUUID(), versionId: randomUUID(), ...decision },
    });
  }, 120_000);

  it('refuses a board read on a foreign or fabricated board, never an empty success', async () => {
    // RED at 74d583c: `task.board` takes a board identifier
    // (`reads/dispatch.ts:241-243`) and answers 200 `{ tasks: [] }` for one
    // that is not alpha's. Case 1 asks `NOT_FOUND`, and case 3 says a denied
    // list is never empty. `task.move` refuses the same identifier
    // `NOT_FOUND` (`commands/tasks-place.ts:113-122`).
    await refuses('task.board', 'board', ada, 'NOT_FOUND', {
      foreign: { board: w.foreign.task.id },
      fabricated: { board: randomUUID() },
    });
  }, 120_000);

  it('refuses the agent alike on foreign, fabricated and in-business operands', async () => {
    const own = await w.pickUp(w.h.world.agent, 'the agent’s own work');
    const agent: Presenter = {
      kind: 'agent',
      identity: w.h.world.agent,
      credential: own.credential,
    };
    const sibling = await w.h.freshTask('a sibling outside the delegation');
    const f = w.foreign;
    const other = w.otherPicked;
    const byRecord: readonly [CommandName, Body][] = [
      ['task.read', {}],
      ['task.comment', { body: NOBODY, audience: 'internal' }],
    ];
    for (const [op, extra] of byRecord) {
      // eslint-disable-next-line no-await-in-loop
      await refuses(op, 'recordId', agent, 'DELEGATION_OUT_OF_PURPOSE', {
        foreign: { recordId: f.task.id, ...extra },
        fabricated: { recordId: randomUUID(), ...extra },
        'same business': { recordId: sibling.id, ...extra },
      });
    }
    const byLease: readonly [CommandName, Body][] = [
      ['task.heartbeat', {}],
      ['task.handback', { outcome: 'completed', report: { wrote: NOBODY } }],
    ];
    for (const [op, extra] of byLease) {
      const forms = {
        foreign: { leaseId: f.picked.leaseId, fence: f.picked.fence, ...extra },
        fabricated: { leaseId: randomUUID(), fence: 1, ...extra },
        'same business': { leaseId: other.leaseId, fence: other.fence, ...extra },
      };
      const apart = { 'same business': 'DELEGATION_OUT_OF_PURPOSE' };
      // eslint-disable-next-line no-await-in-loop
      await refuses(op, 'leaseId', agent, 'LEASE_NOT_OWNED', forms, apart);
    }
  }, 300_000);

  it('refuses a pickup alike on a foreign, a fabricated and a claimed reservation', async () => {
    // RED at 74d583c for the third form: the answer for a reservation another
    // agent already claimed names the lease that claimed it ("already claimed
    // by lease <id>"), an alpha identifier this agent was never given. No
    // delegation is live here, so nothing else would have shown it one.
    const agent: Presenter = { kind: 'agent', identity: w.h.world.agent };
    await refuses('task.pickup', 'reservationId', agent, 'RESERVATION_NOT_CLAIMABLE', {
      foreign: { reservationId: w.foreign.picked.reservationId },
      fabricated: { reservationId: randomUUID() },
      'same business': { reservationId: w.otherPicked.reservationId },
    });
  }, 120_000);

  it('refuses a target a target-free operation has no use for (SC2 reading)', async () => {
    // The nine that name no identifier: a positive request moves and shows
    // nothing of bravo's, and a target it would ignore is refused. The
    // reading (TRANSACTION-CONTRACT line 113) is the root's to accept.
    const TARGET_FREE: readonly [CommandName, Body][] = [
      ['task.create', { fields: { title: 'a task made while bravo is watched' } }],
      ['task.purge', { olderThanDays: 3650 }],
      ['settings.set_four_eyes_threshold', { value: 1300 }],
      ['settings.set_client_sign_off', { value: false }],
      ['task.queue', {}],
      ['person.list', {}],
      ['preset.plan', { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] }],
      ['settings.read', {}],
      ['session.capabilities', {}],
    ];
    const caller = w.h.world.ada;
    const answered: Record<string, string> = {};
    for (const [op, body] of TARGET_FREE) {
      /* eslint-disable no-await-in-loop -- one operation at a time */
      const before = await domainState(w.h, [bravo]);
      const positive = await w.person(caller, op, body);
      expect(positive.code, `${op}: ${JSON.stringify(positive.body)}`).toBe('ok');
      expect(JSON.stringify(positive.body), op).not.toContain(w.foreign.task.id);
      expect(JSON.stringify(positive.body), op).not.toContain(w.foreign.admin.personId);
      const aimed = await w.person(caller, op, { ...body, recordId: w.foreign.task.id });
      expect(await domainState(w.h, [bravo]), `${op}: bravo`).toStrictEqual(before);
      /* eslint-enable no-await-in-loop */
      expect(JSON.stringify(aimed.body), op).not.toContain(w.foreign.admin.personId);
      answered[op] = aimed.code;
    }
    // RED at 74d583c for the five reads: a read takes a `recordId` it has no
    // use for and answers as if it had not been sent (the target check,
    // `commands/prepare.ts:253-266`, runs on the command path only).
    expect(answered).toStrictEqual(
      Object.fromEntries(TARGET_FREE.map(([op]) => [op, 'COMMAND_BODY_INVALID'])),
    );
  }, 300_000);
});
