// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's command-layer world: one business with two client parties, a second
// business, an agent under a live delegation, and the people each named test
// needs. Built on the agent fixture so the delegation and the worker lease are
// the runtime's own, never a stand-in.

import { randomUUID } from 'node:crypto';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { Scope } from '../../packages/core-records/src/authority/grants.ts';

export const ABOUT = 'src/pages/about.md';
export const PAGE = 'https://agency.example/about/';
export const BEFORE =
  '---\ntitle: About\n---\n\nWe are a friendly studio.\n\nA friendly decoy line.\n';
export const AFTER =
  '---\ntitle: About\n---\n\nWe are a welcoming studio.\n\nA friendly decoy line.\n';

/** The grants a correction touches, on one scope. */
async function correctionGrants(world: AgentWorld, member: Member, scope: Scope): Promise<void> {
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, member, 'read', scope, false, 'run');
    await grantTo(tx, member, 'write', scope, false, 'run');
    await grantTo(tx, member, 'decide', scope, false, 'gate');
  });
}

export interface C80World {
  readonly world: AgentWorld;
  /** The agency's own site, and a client's in the same business. */
  readonly partyA: string;
  readonly partyB: string;
  /** Business-wide on run and gate: requests. */
  readonly ava: Decider;
  /** Business-wide on run and gate: the configured approver. */
  readonly ben: Decider;
  /** Business-wide on run and gate, not configured: any other account. */
  readonly cal: Decider;
  /** Party B only. */
  readonly dee: Decider;
  /** Manages settings. */
  readonly admin: Member;
  readonly beta: string;
  /** Business-wide on run and gate in the other business. */
  readonly eve: Member;
  readonly taskA: string;
  as(member: Member, body: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  asIn(
    business: string,
    member: Member,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CommandResult>;
  request(member: Member, overrides?: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  approve(member: Member, correctionId: string, versionId: string): Promise<CommandResult>;
  setApprover(personId: string | null): Promise<CommandResult>;
  stateOf(correctionId: string): Promise<string | undefined>;
  receiptsOf(correctionId: string): Promise<number>;
}

const WHOLE: Scope = { kind: 'business', id: null };

type Body = Readonly<Record<string, unknown>>;

/** Business alpha's people: three business-wide, one on party B only, an administrator. */
async function seedAlpha(world: AgentWorld, partyB: string) {
  await world.db.app.withBusiness(world.business, async (tx) => {
    await installBusinessSettings(tx);
  });
  const [ava, ben, cal, dee] = [
    await world.decider('ava'),
    await world.decider('ben'),
    await world.decider('cal'),
    await world.decider('dee'),
  ];
  for (const member of [ava, ben, cal]) {
    // oxlint-disable-next-line no-await-in-loop -- setup, one business
    await correctionGrants(world, member, WHOLE);
  }
  await correctionGrants(world, dee, { kind: 'party', id: partyB });
  const admin = await enrol(world.db.app, world.business, 'admin');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, admin, 'manage', WHOLE, false, 'settings');
  });
  return { ava, ben, cal, dee, admin };
}

/** Business beta, with one member holding every correction grant there. */
async function seedBeta(world: AgentWorld): Promise<{ beta: string; eve: Member }> {
  const beta = await insertBusiness(world.db.app, `beta${randomUUID().slice(0, 6)}`);
  await installSpine(world.db.app, beta);
  const eve = await enrol(world.db.app, beta, 'eve');
  await world.db.app.withBusiness(beta, async (tx) => {
    await installBusinessSettings(tx);
    await grantTo(tx, eve, 'read', WHOLE, false, 'run');
    await grantTo(tx, eve, 'write', WHOLE, false, 'run');
    await grantTo(tx, eve, 'decide', WHOLE, false, 'gate');
  });
  return { beta, eve };
}

export async function c80World(part: string): Promise<C80World> {
  const world = await agentWorld(part, `c80${randomUUID().slice(0, 6)}`);
  const partyA = randomUUID();
  const partyB = randomUUID();
  const people = await seedAlpha(world, partyB);
  const { beta, eve } = await seedBeta(world);
  const asIn = async (id: string, member: Member, body: Body) =>
    await executeCommand(world.db.app, id, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
  const as = async (member: Member, body: Body) => await asIn(world.business, member, body);
  const created = await as(people.ava, { command: 'task.create', fields: { title: 'About' } });
  if (!('recordId' in created)) throw new Error('c80World: task.create refused');
  const taskA = String(created.recordId);
  return {
    world,
    partyA,
    partyB,
    ...people,
    beta,
    eve,
    taskA,
    as,
    asIn,
    ...commands(world, as, { partyA, taskA, admin: people.admin }),
  };
}

function commands(
  world: AgentWorld,
  as: (member: Member, body: Body) => Promise<CommandResult>,
  at: { readonly partyA: string; readonly taskA: string; readonly admin: Member },
): Pick<C80World, 'request' | 'approve' | 'setApprover' | 'stateOf' | 'receiptsOf'> {
  const one = async (sql: string, parameters: readonly unknown[]) =>
    (await world.db.admin.execute<{ readonly v: string }>(sql, parameters))[0]?.v;
  return {
    request: async (member, overrides = {}) =>
      await as(member, {
        command: 'live_correction.request',
        partyId: at.partyA,
        taskId: at.taskA,
        path: ABOUT,
        word: 'friendly',
        replacement: 'welcoming',
        pageUrl: PAGE,
        baseRevision: 'rev-1',
        before: BEFORE,
        after: AFTER,
        ...overrides,
      }),
    approve: async (member, correctionId, versionId) =>
      await as(member, {
        command: 'live_correction.decide',
        correctionId,
        versionId,
        decision: 'approve',
      }),
    setApprover: async (personId) =>
      await as(at.admin, { command: 'settings.set_live_correction_approver', value: personId }),
    stateOf: async (id) =>
      await one('select state as v from public.live_corrections where id = $1', [id]),
    receiptsOf: async (id) =>
      Number(
        await one(
          'select count(*)::text as v from public.live_correction_receipts where correction_id = $1',
          [id],
        ),
      ),
  };
}
