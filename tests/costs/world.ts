// SPDX-License-Identifier: AGPL-3.0-only
//
// One world for the agent cost reads (skill costing and what our agents cost
// us), over HTTP against a real database, across two businesses that each
// have runs with settled calls, and a third where nothing has run.
//
// Each run is real: a task (with its client when it has one), a proposal, a
// person's approval and the agent's pickup, so the run, its reservation, its
// envelope's currency, its lease and its delegation are the runtime's own.
// Its model calls are the broker's (AW-01) and its definition pin is the
// aw-02 cutover's (a `definition_version` pin, not yet written by anything),
// so both are seeded as the database owner, the way MP-14-7a seeds the
// connector rows. A finished run is handed back through `task.handback`.
// Bravo's runs come the same way, through bravo's own routes, manager and
// agent, so each business's reads have the other's runs to leave out.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, PROPOSAL, type Controls } from '../api/controls-fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import {
  insertDefinition,
  releaseVersion,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';

export const RECORD_CANARY: string = `cost-canary-${randomUUID()}`;
export const BRAVO_CANARY: string = `bravo-cost-canary-${randomUUID()}`;
const DIGEST = 'b'.repeat(64);
/** Bravo's one settled call, a figure no alpha total can hold. */
export const BRAVO_MINOR = 7_777;

/** One model call as the broker leaves it: settled at a price, or its cost not known. */
/** A settled call names the model that answered and its units, as the priced settle writes them, or neither. */
export type Call =
  | {
      readonly state: 'settled';
      readonly minor: number;
      readonly model?: string;
      readonly units?: readonly [number, number];
    }
  | { readonly state: 'liability_unknown' };

export interface RunSpec {
  readonly client?: string;
  readonly skill?: string;
  readonly calls: readonly Call[];
  readonly finish?: boolean;
  /** How long ago its first call started. */
  readonly hoursAgo?: number;
}

export interface Ran {
  readonly runId: string;
  readonly taskId: string;
}

export interface CostWorld {
  readonly controls: Controls;
  readonly alpha: string;
  readonly bravo: string;
  /** `finance:read` business-wide. */
  readonly finance: Member;
  /** `finance:read` on client A only. */
  readonly clientReader: Member;
  /** Every grant but finance's. */
  readonly plain: Member;
  readonly bravoFinance: Member;
  /** Bravo's one run, a settled call of `BRAVO_MINOR`. */
  readonly bravoRun: Ran;
  /** `finance:read` in a third business where nothing has run. */
  readonly charlieFinance: Member;
  readonly agentActorId: string;
  readonly answers: Answer[];
  client(name: string): Promise<string>;
  skill(name: string): Promise<{ readonly id: string; readonly versionId: string }>;
  run(spec: RunSpec): Promise<Ran>;
  read(who: Member, name: string, body?: object, business?: string): Promise<Answer>;
  drop(): Promise<void>;
}

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const detail = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

/** Where a seeded call sits: the run's own step, lease, version, reservation and delegation. */
interface CallPlace {
  readonly business: string;
  readonly runId: string;
  readonly stepId: unknown;
  readonly leaseId: unknown;
  readonly versionId: unknown;
  readonly reservationId: unknown;
  readonly delegationId: unknown;
  readonly hoursAgo: number;
  readonly minute: number;
}

/** One model call as the broker leaves it, started `minute` minutes into its run. */
async function insertCall(db: FreshDatabase, call: Call, at: CallPlace): Promise<void> {
  const settled = call.state === 'settled';
  await db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
        delegation_id, operation_key, route_key, route_reach, credential_kind, state,
        reserved_minor, actual_minor, accepted_at, started_at, completed_at, ended_at,
        model_id, input_units, output_units, unknown_since)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'model.replay_compose', 'local.test',
             'local', 'subscription', $9, $10, $11,
             now() - make_interval(hours => $12::int),
             now() - make_interval(hours => $12::int) + make_interval(mins => $13::int),
             case when $14::boolean then now() - make_interval(hours => $12::int)
                    + make_interval(mins => $13::int + 1) end,
             case when $14::boolean then now() - make_interval(hours => $12::int)
                    + make_interval(mins => $13::int + 1) end,
             $15, $16, $17, case when $14::boolean then null else now() end)`,
    [
      at.business,
      randomUUID(),
      at.runId,
      at.stepId,
      at.leaseId,
      at.versionId,
      at.reservationId,
      at.delegationId,
      call.state,
      settled ? Math.max(call.minor, 1) : 500,
      settled ? call.minor : null,
      at.hoursAgo,
      at.minute,
      settled,
      settled ? (call.model ?? null) : null,
      settled ? (call.units?.[0] ?? null) : null,
      settled ? (call.units?.[1] ?? null) : null,
    ],
  );
}

// eslint-disable-next-line max-lines-per-function -- the world and its helpers, built in one place
export async function createCostWorld(part: string): Promise<CostWorld> {
  const controls = await createControls(part);
  const { db, business: alpha } = controls.fixture;
  const finance = await enrol(db.app, alpha, 'finance');
  const clientReader = await enrol(db.app, alpha, 'clientfinance');
  const plain = await enrol(db.app, alpha, 'plain');
  const whole = { kind: 'business', id: null } as const;
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, controls.manager, 'write', whole, false, 'record');
    await grantTo(tx, controls.manager, 'share', whole, false, 'task');
    await grantTo(tx, finance, 'read', whole, false, 'finance');
    await grantTo(tx, plain, 'read', whole, false, 'task');
    await grantTo(tx, plain, 'read', whole, false, 'connection');
    await grantTo(tx, plain, 'decide', whole, false, 'billing');
  });
  const bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, bravo);
  const bravoFinance = await enrol(db.app, bravo, 'bravofinance');
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoFinance, 'read', whole, false, 'finance');
    await insertDefinition(tx, {
      kind: 'skill',
      name: `Bravo skill ${BRAVO_CANARY}`,
      actorId: bravoFinance.actorId,
    });
  });
  // Bravo's own manager and agent, installed as the API fixture installs alpha's.
  const bravoManager = await enrol(db.app, bravo, 'bravomanager');
  const bravoAgent = `agent-${randomUUID()}`;
  await db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment', 'manage'] as const) {
      // eslint-disable-next-line no-await-in-loop -- a grant reads the granter's own rows
      await grantTo(tx, bravoManager, action);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', 500000, 'AUD')`,
      [bravo, randomUUID()],
    );
    const actorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      bravo,
      actorId,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [bravo, randomUUID(), await insertLogin(tx, bravoAgent), actorId, bravoManager.actorId],
    );
  });
  const charlie = await insertBusiness(db.app, 'charlie');
  await installSpine(db.app, charlie);
  const charlieFinance = await enrol(db.app, charlie, 'charliefinance');
  await db.app.withBusiness(charlie, async (tx) => {
    await grantTo(tx, charlieFinance, 'read', whole, false, 'finance');
  });
  const { agentActorId } = controls.fixture;
  const answers: Answer[] = [];
  const inAlpha = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await db.app.withBusiness(alpha, run);

  async function seedCalls(
    ran: Ran,
    picked: Record<string, unknown>,
    spec: RunSpec,
    business = alpha,
  ) {
    const [row] = await db.admin.execute<{
      readonly reservation_id: string;
      readonly version_id: string;
      readonly step_id: string;
    }>(
      `select r.id as reservation_id, r.version_id,
              (select s.id from public.planned_steps s
                where s.business_id = r.business_id and s.run_id = r.run_id
                order by s.ordinal limit 1) as step_id
         from public.reservations r
        where r.business_id = $1 and r.run_id = $2
        order by r.created_at limit 1`,
      [business, ran.runId],
    );
    let minute = 0;
    for (const call of spec.calls) {
      minute += 1;
      // eslint-disable-next-line no-await-in-loop -- a handful of rows in order
      await insertCall(db, call, {
        business,
        runId: ran.runId,
        stepId: row?.step_id,
        leaseId: picked['leaseId'],
        versionId: row?.version_id,
        reservationId: row?.reservation_id,
        delegationId: picked['delegationId'],
        hoursAgo: spec.hoursAgo ?? 1,
        minute,
      });
    }
    if (spec.skill !== undefined) {
      await db.admin.execute(
        `insert into public.run_definition_pins
           (business_id, run_id, ref_kind, content_digest, content_size, definition_version_id,
            manifest, manifest_digest, pinned_by_actor_id)
         values ($1, $2, 'definition_version', $3, 1234, $4, '[]'::jsonb, $3, $5)`,
        [alpha, ran.runId, DIGEST, spec.skill, controls.manager.actorId],
      );
    }
  }

  /** One run in bravo through bravo's routes, with one settled call of `BRAVO_MINOR`. */
  async function runInBravo(): Promise<Ran> {
    const manager = await tokenFor(bravoManager.presented.subject);
    const asManager = async (name: string, body: object): Promise<Record<string, unknown>> => {
      const answer = await post(
        controls.api,
        path('bravo', name),
        { operationId: randomUUID(), ...body },
        authorised(manager),
      );
      expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(200);
      return answer.body;
    };
    const task = await asManager('task.create', { fields: { title: `bravo ${BRAVO_CANARY}` } });
    const proposal = detail({
      status: 200,
      body: await asManager('task.propose', {
        recordId: task['recordId'],
        expectedRevision: task['revision'],
        ...PROPOSAL,
      }),
    });
    const decided = await asManager('task.decide', {
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    });
    const pickup = await post(
      controls.api,
      '/api/a/b/bravo/task/pickup',
      {
        operationId: randomUUID(),
        reservationId: detail({ status: 200, body: decided })['reservationId'],
      },
      authorised(await tokenFor(bravoAgent)),
    );
    expect(pickup.status, JSON.stringify(pickup.body)).toBe(200);
    const picked = detail(pickup);
    const [run] = await db.admin.execute<{ readonly run_id: string }>(
      `select run_id from public.leases where business_id = $1 and id = $2`,
      [bravo, picked['leaseId']],
    );
    const ran = { runId: String(run?.run_id), taskId: String(task['recordId']) };
    await seedCalls(ran, picked, { calls: [{ state: 'settled', minor: BRAVO_MINOR }] }, bravo);
    return ran;
  }
  const bravoRun = await runInBravo();

  return {
    controls,
    alpha,
    bravo,
    finance,
    clientReader,
    plain,
    bravoFinance,
    bravoRun,
    charlieFinance,
    agentActorId,
    answers,
    async client(name) {
      const made = await controls.asPerson('record.create', {
        type: 'client',
        fields: { name: `${name} ${RECORD_CANARY}` },
      });
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      return String(detail(made)['recordId']);
    },
    async skill(name) {
      return await inAlpha(async (tx) => {
        const id = await insertDefinition(tx, {
          kind: 'skill',
          name,
          actorId: controls.manager.actorId,
        });
        const version = await releaseVersion(tx, {
          definitionId: id,
          contentDigest: DIGEST,
          contentSize: 1234,
          inputs: [],
          operations: ['report.send'],
          modes: ['manual'],
          actorId: controls.manager.actorId,
        });
        if (version === null || version === 'raced') throw new Error(`release ${version}`);
        return { id, versionId: version.id };
      });
    },
    async run(spec) {
      let task = await controls.createTask(`costed ${RECORD_CANARY}`);
      if (spec.client !== undefined) {
        const set = await controls.asPerson('task.set_party', {
          recordId: task.id,
          expectedRevision: task.revision,
          fields: { client: spec.client },
        });
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        task = { id: task.id, revision: Number(set.body['revision']) };
      }
      const proposal = await controls.propose(task.id, task.revision);
      const picked = await controls.pickup(await controls.approve(proposal));
      const [run] = await db.admin.execute<{ readonly run_id: string }>(
        `select run_id from public.leases where business_id = $1 and id = $2`,
        [alpha, picked['leaseId']],
      );
      const ran = { runId: String(run?.run_id), taskId: task.id };
      await seedCalls(ran, picked, spec);
      if (spec.finish === true) {
        const handed = await controls.asAgent(
          'task.handback',
          {
            leaseId: picked['leaseId'],
            fence: picked['fence'],
            outcome: 'completed',
            report: { wrote: 'a draft' },
          },
          String(picked['credential']),
        );
        expect(handed.status, JSON.stringify(handed.body)).toBe(200);
      } else {
        await controls.asPerson('delegation.revoke', { delegationId: picked['delegationId'] });
      }
      return ran;
    },
    async read(who, name, body = {}, business = 'alpha') {
      const answer = await post(
        controls.api,
        path(business, name),
        { operationId: randomUUID(), ...body },
        authorised(await tokenFor(who.presented.subject)),
      );
      answers.push(answer);
      return answer;
    },
    async drop() {
      await controls.drop();
    },
  };
}
