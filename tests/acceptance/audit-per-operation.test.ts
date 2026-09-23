// SPDX-License-Identifier: AGPL-3.0-only
//
// I13 and I08 over the whole exported surface, through the real boundary.
//
// **I13** (CONTRACT-LEDGER I13). For each of the 35 `COMMAND_SURFACE`
// declarations, one call that applies and one that is refused, and what each
// wrote to `audit_events` in *every* business: one row, in the caller's own,
// naming actor, command, operation, outcome and code, the request as a digest
// only. A refused call also leaves both businesses' domain tables alone. The
// refused call is R2's (`noah`, no grant: contract 8.2 case 3) wherever R2 has
// one; the three lease operations are refused the agent's own way.
//
// **I08** (CONTRACT-LEDGER I08, contract 8.2 case 6). An agent's call draws on
// its approver's grant (`tasks-runtime.ts:354`, `delegations.ts:365-372`); once
// `grant.revoke` takes it, the next call is `DELEGATION_NARROWED`, audited.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  READS,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { subjectDigest } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import { ADMIN_ACTIONS, ADMIN_COLLECTIONS, enrolAgent, enrolCaller } from './cast.ts';
import { PROPOSAL } from './role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type AgentIdentity,
  type Answer,
  type Caller,
} from './world.ts';
import {
  auditMark,
  auditSince,
  createIdentWorld,
  domainState,
  expectAudited,
  type IdentWorld,
  type Picked,
} from './ident-audit-cases.ts';

/** One call, and what its audit row has to say about it. */
interface Cell {
  readonly send: () => Promise<Answer>;
  readonly actorId: string;
  readonly body: Record<string, unknown>;
  /** The refusal the contract expects, or null for a call that applies. */
  readonly code: string | null;
  /** A read on the person path records no operation identity (`reads/dispatch.ts:83`). */
  readonly personRead: boolean;
}

const READ_NAMES: ReadonlySet<CommandName> = new Set(READS);
const LEASE_WORK: readonly CommandName[] = ['task.pickup', 'task.handback', 'task.heartbeat'];

describe.skipIf(serverUrl === undefined)('I13 and I08: audit per exported operation', () => {
  let w: IdentWorld;
  const covered = { applied: new Set<string>(), refused: new Set<string>() };

  beforeAll(async () => {
    w = await createIdentWorld('audit_per_op');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const both = (): readonly string[] => [w.h.world.alpha, w.h.world.bravo];

  function personCell(caller: Caller, name: CommandName, body: object, code: string | null): Cell {
    const sent = { operationId: randomUUID(), ...body };
    return {
      send: () => w.person(caller, name, sent),
      actorId: caller.actorId as string,
      body: sent,
      code,
      personRead: READ_NAMES.has(name),
    };
  }

  function agentCell(
    identity: AgentIdentity,
    name: CommandName,
    body: object,
    credential: string | undefined,
    code: string | null,
  ): Cell {
    const sent = { operationId: randomUUID(), ...body };
    return {
      send: () => w.agent(identity, name, sent, credential),
      actorId: identity.actorId,
      body: sent,
      code,
      personRead: false,
    };
  }

  /** A fresh agent login, so no pickup in one cell shares a delegation with another. */
  const freshAgent = async (): Promise<AgentIdentity> =>
    await enrolAgent(w.h.world.db, w.h.world.alpha, w.h.world.ada.actorId as string);

  /** Propose and approve as `approver`, answering the reservation it holds. */
  async function reservationBy(approver: Caller, title: string): Promise<string> {
    const made = await w.person(approver, 'task.create', { fields: { title } });
    const proposed = await w.person(approver, 'task.propose', {
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      ...PROPOSAL,
    });
    const gate = proposed.body['detail'] as Record<string, unknown>;
    const decided = await w.person(approver, 'task.decide', {
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved for the audit proof',
    });
    const detail = decided.body['detail'] as Record<string, unknown> | undefined;
    if (decided.code !== 'ok' || detail === undefined) {
      throw new Error(`audit: decide refused ${decided.code}`);
    }
    return String(detail['reservationId']);
  }

  async function pickUpBy(approver: Caller, agent: AgentIdentity, title: string): Promise<Picked> {
    const reservationId = await reservationBy(approver, title);
    const picked = await w.agent(agent, 'task.pickup', { reservationId });
    const detail = picked.body['detail'] as Record<string, unknown> | undefined;
    if (picked.code !== 'ok' || detail === undefined) {
      throw new Error(`audit: pickup refused ${picked.code}`);
    }
    return {
      taskId: String(detail['taskId']),
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
      delegationId: String(detail['delegationId']),
      credential: String(detail['credential']),
      reservationId,
    };
  }

  async function applied(declaration: CommandDeclaration): Promise<Cell> {
    const { name } = declaration;
    const ada = w.h.world.ada;
    switch (name) {
      case 'task.pickup': {
        const agent = await freshAgent();
        const reservationId = await reservationBy(ada, 'work an agent picks up');
        return agentCell(agent, name, { reservationId }, undefined, null);
      }
      case 'task.heartbeat':
      case 'task.handback': {
        const agent = await freshAgent();
        const p = await pickUpBy(ada, agent, `work for ${name}`);
        const lease = { leaseId: p.leaseId, fence: p.fence };
        const settle = { outcome: 'completed', report: { wrote: 'a draft for the audit' } };
        const body = name === 'task.handback' ? { ...lease, ...settle } : lease;
        return agentCell(agent, name, body, p.credential, null);
      }
      case 'grant.revoke': {
        const rows = await w.h.world.db.admin.execute<{ readonly id: string }>(
          `select id from public.grants
            where business_id = $1 and subject_kind = 'person' and subject_id = $2
              and collection = 'task' and action = 'comment' and revoked_at is null`,
          [w.h.world.alpha, w.h.world.mia.personId],
        );
        return personCell(ada, name, { grantId: rows[0]?.id }, null);
      }
      case 'delegation.revoke': {
        const p = await pickUpBy(ada, await freshAgent(), 'work whose delegation is revoked');
        return personCell(ada, name, { delegationId: p.delegationId }, null);
      }
      default: {
        const prepared = await w.h.positiveBody(declaration);
        if ('exception' in prepared) throw new Error(`audit: no body for ${name}`);
        return personCell(ada, name, prepared.body, null);
      }
    }
  }

  async function refused(declaration: CommandDeclaration): Promise<Cell> {
    const { name } = declaration;
    switch (name) {
      case 'task.pickup':
        return agentCell(
          await freshAgent(),
          name,
          { reservationId: randomUUID() },
          undefined,
          'RESERVATION_NOT_CLAIMABLE',
        );
      case 'task.heartbeat':
      case 'task.handback': {
        const agent = await freshAgent();
        const p = await pickUpBy(w.h.world.ada, agent, `work refused ${name}`);
        const lease = { leaseId: randomUUID(), fence: p.fence };
        const settle = { outcome: 'completed', report: { wrote: 'a refused draft' } };
        const body = name === 'task.handback' ? { ...lease, ...settle } : lease;
        return agentCell(agent, name, body, p.credential, 'LEASE_NOT_OWNED');
      }
      default: {
        // `session.capabilities` included: contract 8.2 case 3 names every
        // endpoint, and the root's routing (ROOT-REVIEW-74d583c-ROUTING) says
        // the membership-only answer is to be repaired, not waived.
        const { operationId: _identity, ...probe } = w.h.probeBody(declaration);
        return personCell(w.h.world.noah, name, probe, 'SCOPE_NOT_GRANTED');
      }
    }
  }

  /** Send one cell and answer every way it departs from I13, or nothing. */
  async function check(label: string, name: CommandName, cell: Cell): Promise<readonly string[]> {
    const problems: string[] = [];
    const before = cell.code === null ? undefined : await domainState(w.h, both());
    const mark = await auditMark(w.h);
    const answer = await cell.send();
    const rows = await auditSince(w.h, mark);
    const attempt = (what: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        problems.push(`${label} ${what}: ${(error as Error).message.split('\n')[0]}`);
      }
    };
    attempt('answer', () => {
      expect(answer.code, JSON.stringify(answer.body).slice(0, 200)).toBe(cell.code ?? 'ok');
    });
    attempt('audit', () => {
      expectAudited(label, rows, {
        businessId: w.h.world.alpha,
        actorId: cell.actorId,
        command: name,
        operationId: cell.personRead ? null : String(cell.body['operationId']),
        outcome: cell.code === null ? 'applied' : 'refused',
        refusalCode: cell.code,
        body: cell.body,
      });
    });
    if (before !== undefined) {
      const after = await domainState(w.h, both());
      attempt('state', () => {
        expect(after).toStrictEqual(before);
      });
    }
    return problems;
  }

  for (const [way, cellOf, title] of [
    ['applied', applied, 'audits one applied call of every operation, own tenant, digest only'],
    ['refused', refused, 'audits one refused call of every operation with no domain effect'],
  ] as const) {
    it(
      title,
      async () => {
        const problems: string[] = [];
        for (const declaration of COMMAND_SURFACE) {
          // eslint-disable-next-line no-await-in-loop -- one operation at a time; the chain is shared
          const cell = await cellOf(declaration);
          // eslint-disable-next-line no-await-in-loop
          problems.push(...(await check(`${way} ${declaration.name}`, declaration.name, cell)));
          covered[way].add(declaration.name);
        }
        expect(problems).toStrictEqual([]);
      },
      300_000,
    );
  }

  it('covered all 35 exported operations both ways', () => {
    const names = COMMAND_SURFACE.map((declaration) => declaration.name).toSorted();
    expect(names).toHaveLength(35);
    expect([...covered.applied].toSorted()).toStrictEqual(names);
    expect([...covered.refused].toSorted()).toStrictEqual(names);
  });

  it('audits the person-path refusal of the three lease operations', async () => {
    // PERSON-WORK serves these to a person (8c08ccb). A handback carries the
    // outcome it validates first (`tasks-runtime.ts` `settle`), so the refusal
    // is the lease's. Whatever it answers, I13 wants the attempt recorded.
    const problems: string[] = [];
    for (const name of LEASE_WORK) {
      const lease = { leaseId: randomUUID(), fence: 1 };
      const pick: Record<string, unknown> =
        name === 'task.pickup'
          ? { reservationId: randomUUID() }
          : { ...lease, ...(name === 'task.handback' && { outcome: 'completed', report: {} }) };
      /* eslint-disable no-await-in-loop -- a first call learns the code, a distinct second is checked */
      const seen = await w.person(w.h.world.ada, name, pick);
      expect(seen.code, name).not.toBe('ok');
      const cell = personCell(w.h.world.ada, name, pick, seen.code);
      problems.push(...(await check(`person ${name} (${seen.code})`, name, cell)));
      /* eslint-enable no-await-in-loop */
    }
    expect(problems).toStrictEqual([]);
  }, 120_000);

  it('records a body that is not an object as one admission refusal, on both prefixes', async () => {
    // Root ruling 4: no domain actor exists yet, so the attempt owner records it
    // (`recordBodyRefusal`, `identity/authentication-attempts.ts`), subject digest
    // only, and no `audit_events` row carries an invented actor.
    const world = w.h.world;
    const attempts = async (): Promise<readonly Record<string, unknown>[]> =>
      await world.db.admin.execute('select * from public.authentication_attempts order by id');
    for (const [owner, path, who] of [
      ['person_login', personPath('alpha', '/task/create'), world.ada],
      ['agent_login', agentPath('alpha', '/task/queue'), world.agent],
    ] as const) {
      /* eslint-disable no-await-in-loop -- each prefix against its own before and after */
      const before = await attempts();
      const mark = await auditMark(w.h);
      const state = await domainState(w.h, both());
      const answer = await call(world.api, path, ['not', 'an', 'object'], bearer(who.token));
      const known = new Set(before.map((row) => row['id']));
      const added = (await attempts()).filter((row) => !known.has(row['id']));
      expect(answer.code, owner).toBe('COMMAND_BODY_INVALID');
      expect(await auditSince(w.h, mark), `${owner}: audit_events`).toStrictEqual([]);
      expect(await domainState(w.h, both()), owner).toStrictEqual(state);
      /* eslint-enable no-await-in-loop */
      expect(
        added.map(({ id: _id, at: _at, ...row }) => row),
        `${owner}: authentication_attempts`,
      ).toStrictEqual([
        {
          business_id: world.alpha,
          owner,
          provider: who.presented.provider,
          subject_digest: subjectDigest(who.presented),
          outcome: 'refused',
          refusal_code: 'COMMAND_BODY_INVALID',
          login_id: null,
          actor_id: null,
          person_id: null,
        },
      ]);
    }
  }, 60_000);

  describe('I08: the agent narrows with its approving person', () => {
    const CASES: readonly (readonly [CommandName, string])[] = [
      ['task.read', 'read'],
      ['task.comment', 'comment'],
      ['task.heartbeat', 'write'],
      ['task.handback', 'write'],
    ];

    for (const [name, action] of CASES) {
      it(`${name} refuses DELEGATION_NARROWED once task:${action} is revoked`, async () => {
        const world = w.h.world;
        const approver = await enrolCaller(world.db, world.alpha, 'alpha', 'ivy', {
          membership: true,
          actions: ADMIN_ACTIONS,
          collections: ADMIN_COLLECTIONS,
        });
        const agent = await freshAgent();
        const p = await pickUpBy(approver, agent, `work narrowed on ${name}`);
        const lease = { leaseId: p.leaseId, fence: p.fence };
        const bodies: Partial<Record<CommandName, Record<string, unknown>>> = {
          'task.read': { recordId: p.taskId },
          'task.comment': {
            recordId: p.taskId,
            body: 'the agent writes a note',
            audience: 'internal',
          },
          'task.heartbeat': lease,
        };
        const bodyFor = (): Record<string, unknown> =>
          bodies[name] ?? { ...lease, outcome: 'completed', report: { wrote: 'a narrowed draft' } };

        // The control: the same authority, still held, admits the agent.
        const controlName = name === 'task.handback' ? 'task.heartbeat' : name;
        const controlBody = name === 'task.handback' ? lease : bodyFor();
        const control = await w.agent(agent, controlName, controlBody, p.credential);
        expect(control.code, `control ${controlName}`).toBe('ok');

        const grants = await world.db.admin.execute<{ readonly id: string }>(
          `select id from public.grants
            where business_id = $1 and subject_kind = 'person' and subject_id = $2
              and collection = 'task' and action = $3 and revoked_at is null`,
          [world.alpha, approver.personId, action],
        );
        expect(grants.length).toBeGreaterThan(0);
        for (const grant of grants) {
          // eslint-disable-next-line no-await-in-loop -- through the owning route, one at a time
          const revoked = await w.person(world.ada, 'grant.revoke', { grantId: grant.id });
          expect(revoked.code, 'grant.revoke').toBe('ok');
        }

        // RED for write since 676cf71: authority loss revokes the delegation
        // (`core-runtime/src/recovery.ts:723`, 9af0262, and `:384` in retireWork),
        // so heartbeat and handback get DELEGATION_NOT_LIVE, not case 6's code.
        const cell = agentCell(agent, name, bodyFor(), p.credential, 'DELEGATION_NARROWED');
        expect(await check(`narrowed ${name}`, name, cell)).toStrictEqual([]);
      }, 120_000);
    }
  });
});
