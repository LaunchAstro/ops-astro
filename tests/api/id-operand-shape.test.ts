// SPDX-License-Identifier: AGPL-3.0-only
//
// A malformed identifier names nothing, so it answers exactly as a fabricated
// one does. At 6f15252 the agent's `task.pickup` with `reservationId: ""` went
// on to a uuid parameter and came back 503 SERVICE_UNAVAILABLE (the live
// `invalid input syntax for type uuid: ""`): a caller's input answered as an
// infrastructure fault, which TRANSACTION-CONTRACT TC:11 reserves for real
// faults. Root ruling 2 asks that a fabricated id be indistinguishable from a
// foreign one; this suite asks the same of `""` and `"not-a-uuid"` against a
// well-formed fabricated uuid, for every id operand of every operation on both
// prefixes, through the real routes.
//
// Each malformed form must give the fabricated form's status and body byte for
// byte, with nothing normalised; one refused audit row in the caller's
// business; and no change to either business's tenant tables. A form an
// operation already refuses by its own typed code (a field value of the wrong
// type, an empty batch id) keeps that code and is asserted on it alone.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { READS } from '../../packages/core-records/src/commands/surface.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import { serverUrl, type AgentIdentity, type Caller } from '../acceptance/world.ts';
import {
  auditMark,
  auditSince,
  createIdentWorld,
  domainState,
  expectAudited,
  type IdentWorld,
  type Picked,
  type RawAnswer,
} from '../acceptance/ident-audit-cases.ts';

type Body = Readonly<Record<string, unknown>>;

type Presenter =
  | { readonly kind: 'person'; readonly caller: Caller }
  | { readonly kind: 'agent'; readonly identity: AgentIdentity; readonly credential?: string };

/** The two malformed spellings, and the well-formed one that names nothing. */
const MALFORMED: Readonly<Record<string, string>> = { empty: '', 'not a uuid': 'not-a-uuid' };

const NOBODY = 'text nobody should find in an audit row';

interface Cell {
  readonly op: CommandName;
  readonly operand: string;
  readonly by: Presenter;
  /** The operation's answer for a fabricated id, which a malformed one must repeat. */
  readonly code: string;
  readonly body: (id: unknown) => Body | Promise<Body>;
  /** A malformed form the operation already refuses by a typed code of its own. */
  readonly apart?: Readonly<Record<string, string>>;
  /**
   * Open at this head, not a fault: the generic malformed-identifier refusal in
   * `commands/prepare.ts` answers first, in the fabricated form's status and
   * code but not its `names` and `fixes`. Asserted on status and code; the
   * bytes are handed back (ID-OPERANDS unfinished 1).
   */
  readonly codeOnly?: true;
}

const actorOf = (by: Presenter): string =>
  by.kind === 'person' ? (by.caller.actorId as string) : by.identity.actorId;

describe.skipIf(serverUrl === undefined)('id operand shape (TC:11, root ruling 2)', () => {
  let w: IdentWorld;
  let alpha: string;
  let bravo: string;
  let ada: Presenter;

  beforeAll(async () => {
    w = await createIdentWorld('id_operand_shape');
    alpha = w.h.world.alpha;
    bravo = w.h.world.bravo;
    ada = { kind: 'person', caller: w.h.world.ada };
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  async function send(by: Presenter, op: CommandName, body: Body): Promise<RawAnswer> {
    return by.kind === 'person'
      ? await w.person(by.caller, op, body)
      : await w.agent(by.identity, op, body, by.credential);
  }

  /** One form: its answer, one refused audit row at home, and nothing moved. */
  async function refusedAlone(cell: Cell, form: string, id: unknown): Promise<RawAnswer> {
    const label = `${cell.op} ${cell.operand} ${form}`;
    const body = { operationId: randomUUID(), ...(await cell.body(id)) };
    const before = await domainState(w.h, [alpha, bravo]);
    const mark = await auditMark(w.h);
    const answer = await send(cell.by, cell.op, body);
    const rows = await auditSince(w.h, mark);
    const after = await domainState(w.h, [alpha, bravo]);
    const code = cell.apart?.[form] ?? cell.code;
    expect.soft(answer.status, `${label}: ${answer.text}`).not.toBe(503);
    expect(answer.code, `${label}: ${answer.text}`).toBe(code);
    expect(after, `${label}: durable state`).toStrictEqual(before);
    expectAudited(label, rows, {
      businessId: alpha,
      actorId: actorOf(cell.by),
      command: cell.op,
      // A person's read records no operation (`reads/dispatch.ts:83`).
      operationId: READS.includes(cell.op) && cell.by.kind === 'person' ? null : body.operationId,
      outcome: 'refused',
      refusalCode: code,
      body,
    });
    return answer;
  }

  /** Every malformed form against the fabricated one, raw bytes unnormalised. */
  async function probe(cells: readonly Cell[]): Promise<void> {
    for (const cell of cells) {
      /* eslint-disable no-await-in-loop -- each form against its own before and after */
      const fabricated = await refusedAlone(cell, 'fabricated', randomUUID());
      for (const [form, id] of Object.entries(MALFORMED)) {
        const answer = await refusedAlone(cell, form, id);
        if (cell.apart?.[form] !== undefined) continue;
        const label = `${cell.op} ${cell.operand}: fabricated against ${form}`;
        expect.soft(answer.status, label).toBe(fabricated.status);
        if (cell.codeOnly) expect.soft(answer.code, label).toBe(fabricated.code);
        else expect.soft(answer.text, label).toBe(fabricated.text);
      }
      /* eslint-enable no-await-in-loop */
    }
  }

  /** A fresh alpha task, with a body writing against its current revision. */
  async function onFresh(extra: Body): Promise<Body> {
    const task = await w.h.freshTask('a task an operand is probed on');
    return { recordId: task.id, expectedRevision: task.revision, ...extra };
  }

  it('refuses a malformed task record as a fabricated one, on every targeted operation', async () => {
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
    await probe([
      ...targeted.map(([op, extra]): Cell => ({
        op,
        operand: 'recordId',
        by: ada,
        code: 'NOT_FOUND',
        body: (recordId) => ({ recordId, expectedRevision: 1, ...extra }),
      })),
      {
        op: 'task.read',
        operand: 'recordId',
        by: ada,
        code: 'NOT_FOUND',
        body: (recordId) => ({ recordId }),
      },
      {
        op: 'task.board',
        operand: 'board',
        by: ada,
        code: 'NOT_FOUND',
        body: (board) => ({ board }),
      },
    ]);
  }, 600_000);

  it('refuses a malformed secondary identifier as a fabricated one', async () => {
    const fieldValue = { empty: 'FIELD_VALUE_INVALID', 'not a uuid': 'FIELD_VALUE_INVALID' };
    await probe([
      {
        op: 'task.move',
        operand: 'board',
        by: ada,
        code: 'NOT_FOUND',
        codeOnly: true,
        body: async (board) => await onFresh({ board, boardSection: null }),
      },
      {
        op: 'task.rank',
        operand: 'afterId',
        by: ada,
        code: 'NOT_FOUND',
        codeOnly: true,
        body: async (afterId) => await onFresh({ afterId }),
      },
      {
        op: 'task.rank',
        operand: 'beforeId',
        by: ada,
        code: 'NOT_FOUND',
        codeOnly: true,
        body: async (beforeId) => await onFresh({ beforeId }),
      },
      {
        op: 'task.reparent',
        operand: 'parentId',
        by: ada,
        code: 'NOT_FOUND',
        codeOnly: true,
        body: async (parentId) => await onFresh({ parentId }),
      },
      // A link field's value of the wrong type is FIELD_VALUE_INVALID
      // (`commands/values.ts`), a contract of its own that stays.
      {
        op: 'task.assign',
        operand: 'assignee',
        by: ada,
        code: 'NOT_FOUND',
        apart: fieldValue,
        body: async (assignee) => await onFresh({ fields: { assignee } }),
      },
    ]);
  }, 600_000);

  it('refuses malformed control, gate and authority identifiers as fabricated ones', async () => {
    const own = await w.propose('a lineage of alpha’s own');
    const lineage = (op: CommandName, recordId: unknown, lineageId: unknown): Body =>
      op === 'task.cancel' ? { recordId, lineageId, reason: NOBODY } : { recordId, lineageId };
    const decision = { decision: 'approve', note: NOBODY };
    const cells: Cell[] = [];
    for (const op of ['task.cancel', 'task.restart'] as const) {
      cells.push(
        {
          op,
          operand: 'lineageId',
          by: ada,
          code: 'NOT_FOUND',
          codeOnly: true,
          body: (id) => lineage(op, own.task.id, id),
        },
        {
          op,
          operand: 'recordId',
          by: ada,
          code: 'NOT_FOUND',
          codeOnly: true,
          body: (id) => lineage(op, id, own.lineageId),
        },
      );
    }
    cells.push(
      {
        op: 'task.restore',
        operand: 'batchId',
        by: ada,
        code: 'NOT_FOUND',
        codeOnly: true,
        body: (batchId) => ({ batchId }),
      },
      {
        op: 'grant.revoke',
        operand: 'grantId',
        by: ada,
        code: 'NOT_FOUND',
        body: (grantId) => ({ grantId }),
      },
      {
        op: 'delegation.revoke',
        operand: 'delegationId',
        by: ada,
        code: 'NOT_FOUND',
        body: (delegationId) => ({ delegationId }),
      },
      {
        op: 'task.decide',
        operand: 'gateId',
        by: ada,
        code: 'NOT_FOUND',
        codeOnly: true,
        body: (gateId) => ({ gateId, versionId: own.versionId, ...decision }),
      },
      {
        // A fabricated version on a real gate is VERSION_SUPERSEDED; a malformed one
        // meets the generic NOT_FOUND in `commands/prepare.ts` first. Typed, not a
        // fault, and handed back (ID-OPERANDS unfinished 2).
        op: 'task.decide',
        operand: 'versionId',
        by: ada,
        code: 'VERSION_SUPERSEDED',
        apart: { empty: 'NOT_FOUND', 'not a uuid': 'NOT_FOUND' },
        body: (versionId) => ({ gateId: own.gateId, versionId, ...decision }),
      },
    );
    await probe(cells);
  }, 600_000);

  it('refuses a malformed reservation or lease on the person prefix as a fabricated one', async () => {
    await probe([
      {
        op: 'task.pickup',
        operand: 'reservationId',
        by: ada,
        code: 'RESERVATION_NOT_CLAIMABLE',
        body: (reservationId) => ({ reservationId }),
      },
      {
        op: 'task.heartbeat',
        operand: 'leaseId',
        by: ada,
        code: 'LEASE_NOT_OWNED',
        body: (leaseId) => ({ leaseId, fence: 1 }),
      },
      {
        op: 'task.handback',
        operand: 'leaseId',
        by: ada,
        code: 'LEASE_NOT_OWNED',
        body: (leaseId) => ({ leaseId, fence: 1, outcome: 'completed', report: { wrote: NOBODY } }),
      },
    ]);
  }, 300_000);

  it('refuses a malformed operand on the agent prefix as a fabricated one', async () => {
    // The live 503 at 6f15252: the envelope passes `String(reservationId ?? '')`
    // (`commands/agent-operations.ts`, `task.pickup`'s row) and nothing shaped it before SQL.
    const bare: Presenter = { kind: 'agent', identity: w.h.world.agent };
    await probe([
      {
        op: 'task.pickup',
        operand: 'reservationId',
        by: bare,
        code: 'RESERVATION_NOT_CLAIMABLE',
        body: (reservationId) => ({ reservationId }),
      },
    ]);
    // The positive control: a well-formed approved reservation is still claimed.
    const own: Picked = await w.pickUp(w.h.world.agent, 'the agent’s own work');
    expect(own.leaseId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(own.reservationId).toMatch(/^[0-9a-f-]{36}$/u);
    const agent: Presenter = {
      kind: 'agent',
      identity: w.h.world.agent,
      credential: own.credential,
    };
    await probe([
      {
        op: 'task.read',
        operand: 'recordId',
        by: agent,
        code: 'DELEGATION_OUT_OF_PURPOSE',
        body: (recordId) => ({ recordId }),
      },
      {
        op: 'task.comment',
        operand: 'recordId',
        by: agent,
        code: 'DELEGATION_OUT_OF_PURPOSE',
        body: (recordId) => ({ recordId, body: NOBODY, audience: 'internal' }),
      },
      {
        op: 'task.heartbeat',
        operand: 'leaseId',
        by: agent,
        code: 'LEASE_NOT_OWNED',
        body: (leaseId) => ({ leaseId, fence: own.fence }),
      },
      {
        op: 'task.handback',
        operand: 'leaseId',
        by: agent,
        code: 'LEASE_NOT_OWNED',
        body: (leaseId) => ({
          leaseId,
          fence: own.fence,
          outcome: 'completed',
          report: { wrote: NOBODY },
        }),
      },
    ]);
  }, 300_000);

  it('answers an agent pickup whose reservationId is not a string as the person route does', async () => {
    // Sol 6 AUTHORITY-2. The envelope used to read the operand with
    // `String(... ?? '')`, so a number was the string it spells and an array
    // of one approved id was that id, and claimed it. It is now read by its
    // JSON type (`pickupOperands`): a number is the person route's own
    // COMMAND_BODY_INVALID, byte for byte, and a fabricated string still
    // names nothing.
    const bare: Presenter = { kind: 'agent', identity: w.h.world.agent };
    const cell: Cell = {
      op: 'task.pickup',
      operand: 'reservationId',
      by: bare,
      code: 'COMMAND_BODY_INVALID',
      body: (reservationId) => ({ reservationId }),
    };
    const fabricated = await refusedAlone(
      { ...cell, code: 'RESERVATION_NOT_CLAIMABLE' },
      'fabricated',
      randomUUID(),
    );
    expect(fabricated.status).toBe(409);
    const numeric = await refusedAlone(cell, 'number', 42);
    const person = await refusedAlone({ ...cell, by: ada }, 'number', 42);
    expect(person.status).toBe(400);
    expect(numeric.status).toBe(person.status);
    expect(numeric.text).toBe(person.text);
  }, 120_000);
});
