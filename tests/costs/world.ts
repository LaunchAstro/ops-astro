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
// connector rows (`calls.ts`). A finished run is handed back through
// `task.handback`. Bravo's run comes the same way, through bravo's own routes,
// manager and agent (`bravo.ts`), so each business's reads have the other's
// runs to leave out.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { runInBravo, type Ran } from './bravo.ts';
import { seedRunCalls, type Call } from './calls.ts';

export type { Ran } from './bravo.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import {
  createClient,
  insertDefinition,
  releaseVersion,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';

export const RECORD_CANARY: string = `cost-canary-${randomUUID()}`;
export const BRAVO_CANARY: string = `bravo-cost-canary-${randomUUID()}`;
/** In bravo's client and skill names, which bravo's own answers show and alpha's never may. */
export const BRAVO_NAME: string = `bravo-cost-name-${randomUUID()}`;
const DIGEST = 'b'.repeat(64);
/** Bravo's one settled call, a figure no alpha total can hold. */
export const BRAVO_MINOR = 7_777;

export interface RunSpec {
  readonly client?: string;
  readonly skill?: string;
  readonly calls: readonly Call[];
  readonly finish?: boolean;
  /** How long ago its first call started. */
  readonly hoursAgo?: number;
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
  /** Bravo's one run, a settled call of `BRAVO_MINOR`, on its client and pinned to its skill. */
  readonly bravoRun: Ran;
  readonly bravoClient: string;
  readonly bravoSkill: string;
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

/** A skill with one released version, in the business `tx` serves. */
async function releaseSkill(
  tx: TenantQuery,
  name: string,
  by: Member,
): Promise<{ readonly id: string; readonly versionId: string }> {
  const id = await insertDefinition(tx, { kind: 'skill', name, actorId: by.actorId });
  const version = await releaseVersion(tx, {
    definitionId: id,
    contentDigest: DIGEST,
    contentSize: 1234,
    inputs: [],
    operations: ['report.send'],
    modes: ['manual'],
    actorId: by.actorId,
  });
  if (version === null || version === 'raced') throw new Error(`release ${version}`);
  return { id, versionId: version.id };
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
  const bravoOwn = await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoFinance, 'read', whole, false, 'finance');
    const made = await createClient(tx, `Bravo client ${BRAVO_NAME}`, bravoFinance.actorId);
    if (!made.ok) throw new Error('bravo client was not made');
    return {
      client: made.value,
      ...(await releaseSkill(tx, `Bravo skill ${BRAVO_NAME}`, bravoFinance)),
    };
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
    [business, pinner] = [alpha, controls.manager],
  ) {
    await seedRunCalls(db, business, ran.runId, picked, spec.calls, spec.hoursAgo ?? 1);
    if (spec.skill !== undefined) {
      await db.admin.execute(
        `insert into public.run_definition_pins
           (business_id, run_id, ref_kind, content_digest, content_size, definition_version_id,
            manifest, manifest_digest, pinned_by_actor_id)
         values ($1, $2, 'definition_version', $3, 1234, $4, '[]'::jsonb, $3, $5)`,
        [business, ran.runId, DIGEST, spec.skill, pinner.actorId],
      );
    }
  }

  const bravoCalls = {
    calls: [{ state: 'settled', minor: BRAVO_MINOR }],
    skill: bravoOwn.versionId,
  };
  const bravoRun = await runInBravo(
    controls,
    bravo,
    BRAVO_CANARY,
    bravoOwn.client,
    async (ran, picked) => {
      await seedCalls(ran, picked, bravoCalls as RunSpec, [bravo, bravoFinance]);
    },
  );

  return {
    controls,
    alpha,
    bravo,
    finance,
    clientReader,
    plain,
    bravoFinance,
    bravoRun,
    bravoClient: bravoOwn.client,
    bravoSkill: bravoOwn.id,
    charlieFinance,
    agentActorId,
    answers,
    async client(name) {
      // A client of the business (0055), the row a task's client link and a
      // party grant name.
      const made = await inAlpha(
        async (tx) => await createClient(tx, `${name} ${RECORD_CANARY}`, controls.manager.actorId),
      );
      if (!made.ok) throw new Error(`client ${name} was not made`);
      return made.value;
    },
    async skill(name) {
      return await inAlpha(async (tx) => await releaseSkill(tx, name, controls.manager));
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
