// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's command-layer world: one business with two client parties, each a
// client row with a task under it, a second business with a client and task of
// its own, an agent under a live delegation, and the people each named test
// needs. Built on the agent fixture so the delegation and the worker lease are
// the runtime's own, never a stand-in. A correction's party is its task's
// client (P26 low 4), so every request names the pair that belongs together.

import { randomUUID } from 'node:crypto';
import {
  agentWorld,
  type AgentWorld,
  type Decider,
  type PickedUp,
} from '../commands/agent-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { clientHere } from '../reads/client-rows.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import type { Scope } from '../../packages/core-records/src/authority/grants.ts';

export const ABOUT = 'src/pages/about.md';
export const PAGE = 'https://agency.example/about/';
export const BEFORE =
  '---\ntitle: About\n---\n\nWe are a friendly studio.\n\nA friendly decoy line.\n';
export const AFTER =
  '---\ntitle: About\n---\n\nWe are a welcoming studio.\n\nA friendly decoy line.\n';

/** The one-word request on the about page, at a party and under a task. */
export const requestBody = (
  partyId: string,
  taskId: string,
): Readonly<Record<string, unknown>> => ({
  command: 'live_correction.request',
  partyId,
  taskId,
  path: ABOUT,
  word: 'friendly',
  replacement: 'welcoming',
  pageUrl: PAGE,
  baseRevision: 'rev-1',
  before: BEFORE,
  after: AFTER,
});

/** The grants a correction touches, on one scope. */
async function correctionGrants(world: AgentWorld, member: Member, scope: Scope): Promise<void> {
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, member, 'write', scope, false, 'run');
    await grantTo(tx, member, 'decide', scope, false, 'gate');
  });
}

export interface C80World {
  readonly world: AgentWorld;
  /** The agency's own site, and a client's in the same business: client rows of alpha. */
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
  /** A client of beta's, and a task of beta's under it. */
  readonly betaParty: string;
  readonly betaTask: string;
  /** Tasks under party A and under party B. */
  readonly taskA: string;
  readonly taskB: string;
  as(member: Member, body: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  asIn(
    business: string,
    member: Member,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CommandResult>;
  request(member: Member, overrides?: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  approve(member: Member, correctionId: string, versionId: string): Promise<CommandResult>;
  /** `world.pickUp`, with the task put under `partyId` before its proposal locks the client. */
  pickUpUnder(by: Decider, title: string, partyId: string): Promise<PickedUp>;
  setApprover(personId: string | null): Promise<CommandResult>;
  stateOf(correctionId: string): Promise<string | undefined>;
  receiptsOf(correctionId: string): Promise<number>;
}

const WHOLE: Scope = { kind: 'business', id: null };

type Body = Readonly<Record<string, unknown>>;
type AsIn = (business: string, member: Member, body: Body) => Promise<CommandResult>;

/** A setup step's answer, or the refusal thrown. */
function need(result: CommandResult, what: string): CommandHandle {
  if (isCommandRefusal(result)) throw new Error(`c80World: ${what} refused ${result.code}`);
  return result;
}

/**
 * A task `by` creates, put under `client` by `sharer` (who holds task:share)
 * while it is still empty: the client link a correction's party is read from.
 */
async function taskUnder(
  asIn: AsIn,
  at: { readonly business: string; readonly by: Member; readonly sharer: Member },
  client: string,
  title: string,
): Promise<{ readonly taskId: string; readonly revision: number }> {
  const created = need(
    await asIn(at.business, at.by, { command: 'task.create', fields: { title } }),
    'task.create',
  );
  const set = need(
    await asIn(at.business, at.sharer, {
      command: 'task.set_party',
      recordId: created.recordId,
      expectedRevision: created.revision,
      fields: { client },
    }),
    'task.set_party',
  );
  return { taskId: String(created.recordId), revision: Number(set.revision) };
}

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
  // The administrator also puts the world's tasks under their clients (task:share).
  const admin = await enrol(world.db.app, world.business, 'admin');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, admin, 'manage', WHOLE, false, 'settings');
    await grantTo(tx, admin, 'share');
  });
  return { ava, ben, cal, dee, admin };
}

/**
 * Business beta, with one member holding every correction grant there, and task
 * read, write and share; a client of beta's, and a task of beta's under it.
 */
async function seedBeta(world: AgentWorld, asIn: AsIn) {
  const beta = await insertBusiness(world.db.app, `beta${randomUUID().slice(0, 6)}`);
  await installSpine(world.db.app, beta);
  const eve = await enrol(world.db.app, beta, 'eve');
  await world.db.app.withBusiness(beta, async (tx) => {
    await installBusinessSettings(tx);
    await grantTo(tx, eve, 'write', WHOLE, false, 'run');
    await grantTo(tx, eve, 'decide', WHOLE, false, 'gate');
    for (const action of ['read', 'write', 'share'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- setup, one business
      await grantTo(tx, eve, action);
    }
  });
  const betaParty = await clientHere(world.db.admin, beta, randomUUID());
  const under = await taskUnder(asIn, { business: beta, by: eve, sharer: eve }, betaParty, 'About');
  return { beta, eve, betaParty, betaTask: under.taskId };
}

export async function c80World(part: string): Promise<C80World> {
  const world = await agentWorld(part, `c80${randomUUID().slice(0, 6)}`);
  const partyA = await clientHere(world.db.admin, world.business, randomUUID());
  const partyB = await clientHere(world.db.admin, world.business, randomUUID());
  const people = await seedAlpha(world, partyB);
  const asIn: AsIn = async (id, member, body) =>
    await executeCommand(world.db.app, id, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
  const as = async (member: Member, body: Body) => await asIn(world.business, member, body);
  const theirs = await seedBeta(world, asIn);
  const alpha = { business: world.business, by: people.ava, sharer: people.admin };
  const taskA = (await taskUnder(asIn, alpha, partyA, 'About')).taskId;
  const taskB = (await taskUnder(asIn, alpha, partyB, 'About a client')).taskId;
  return {
    world,
    partyA,
    partyB,
    ...people,
    ...theirs,
    taskA,
    taskB,
    as,
    asIn,
    ...commands(world, as, { partyA, taskA, admin: people.admin }),
    pickUpUnder: async (by, title, partyId) =>
      await pickUpUnder(
        world,
        asIn,
        { business: world.business, by, sharer: people.admin },
        {
          title,
          partyId,
        },
      ),
  };
}

/** `world.pickUp`'s steps, with the client set between the create and the proposal. */
async function pickUpUnder(
  world: AgentWorld,
  asIn: AsIn,
  at: { readonly business: string; readonly by: Member; readonly sharer: Member },
  task: { readonly title: string; readonly partyId: string },
): Promise<PickedUp> {
  const { taskId, revision } = await taskUnder(asIn, at, task.partyId, task.title);
  const proposed = need(
    await asIn(at.business, at.by, {
      command: 'task.propose',
      recordId: taskId,
      expectedRevision: revision,
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
    'task.propose',
  ).detail;
  const decided = need(
    await asIn(at.business, at.by, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    }),
    'task.decide',
  ).detail;
  const reservationId = String(decided['reservationId']);
  const operationId = randomUUID();
  const detail = need(
    await world.asAgent({ command: 'task.pickup', operationId, reservationId }),
    'task.pickup',
  ).detail;
  return {
    taskId,
    credential: String(detail['credential']),
    detail: { ...detail },
    operationId,
    reservationId,
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
      await as(member, { ...requestBody(at.partyA, at.taskA), ...overrides }),
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
