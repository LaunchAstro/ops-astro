// SPDX-License-Identifier: AGPL-3.0-only
//
// What the #1624 R7 database proof of the agent's draft shares, on the stop
// world (`run-stop-world.ts`): the door's broker with the replay turn
// operation, a business made ready for a live correction on its own site (its
// decider the owner, holding run:write, the site bound and an approver named),
// work the owner proposes and the agent picks up, the agent's request at the
// door, and the turns a worker sends with the agent's catalogue. Rows are
// read through the admin connection. `s` and `world` are the stop world's
// live bindings, read by the cases after its beforeAll.

import { randomUUID } from 'node:crypto';
import type { ModelBroker } from '../../packages/core-commands/src/commands/model-call.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  REPLAY_TURN,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  BUSINESS_SETTINGS,
  installBusinessSettings,
} from '../../packages/core-records/src/records/business-settings.ts';
import type { ConfiguredSite } from '../../packages/core-records/src/site/locate.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { AGENT_MODEL_CALL_LIMIT, AGENT_TOOLS } from '../../packages/core-wire/src/index.ts';
import { CLOUD, LOCAL } from '../broker/broker-world.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  approve,
  createTask,
  freshPurpose,
  pickup,
  propose,
  revisionOf,
  rows,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { asWorker, door, s, world, type Answer } from './run-stop-world.ts';

export type Detail = Readonly<Record<string, unknown>>;

export const OWN_PAGE: string = `https://own-${randomUUID().slice(0, 8)}.example/about`;
export const THEIR_PAGE: string = `https://theirs-${randomUUID().slice(0, 8)}.example/about`;
export const WORDS = { word: 'Townsvile', replacement: 'Townsville' } as const;

export const UUID: RegExp = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** The door's broker for the agent: its turn operation, a cloud route and a local one. */
export const agentBroker = (): ModelBroker =>
  ({
    custody: world.custody,
    operations: catalogue([REPLAY_COMPOSE, REPLAY_TURN]),
    providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
    routes: [CLOUD, LOCAL],
    installation: 'here',
    callLimit: AGENT_MODEL_CALL_LIMIT,
  }) as ModelBroker;

const agentDoor = () => door(s.db.app, agentBroker());

/** The replay provider's answer: words, and the tools the model asks for. */
export const replied = (text: string, toolCalls: readonly unknown[] = []): unknown => ({
  text,
  model: 'replay-1',
  usage: { input: 40, output: 30 },
  tool_calls: toolCalls,
});

/** `of`'s decider, holding `role` from now on, as the product changes a role. */
async function movesTo(of: Schedules, role: string): Promise<void> {
  await of.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [of.business, of.decider.personId],
  );
  await of.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [of.business, randomUUID(), of.decider.personId, role],
  );
}

/**
 * `of`'s decider made its owner before any task, holding run:write (so a
 * pickup they approve carries `run`) and task:share; its own site bound with
 * `page`; and an approver named, without whom a request stores nothing. The
 * site as the M5's runner is configured for it.
 */
export async function ownSiteOf(of: Schedules, page: string): Promise<ConfiguredSite> {
  await movesTo(of, 'owner');
  const approver = await enrol(of.db.app, of.business, 'approver');
  const configured = await of.db.app.withBusiness(of.business, async (tx) => {
    const setting = BUSINESS_SETTINGS.filter((each) => each.key === 'live_correction_approver');
    await installBusinessSettings(tx, setting);
    await grantTo(tx, of.decider, 'write', undefined, false, 'run');
    await grantTo(tx, of.decider, 'share');
    const own = randomUUID().slice(0, 8);
    const site = {
      partyId: null,
      repository: `own/site-${own}`,
      defaultBranch: 'main',
      project: `prj_own_${own}`,
      pages: [{ pageUrl: page, path: 'src/pages/about.md' }],
    };
    const bound = await bindPartySite(tx, site, of.decider.actorId);
    if (!bound.ok) throw new Error(`setup: own site bind refused ${bound.code}`);
    return { ...site, holder: of.business };
  });
  await of.db.admin.execute(
    `update public.business_settings set value = to_jsonb($2::text)
      where business_id = $1 and key = 'live_correction_approver'`,
    [of.business, approver.personId],
  );
  return configured;
}

/** The request on `taskId`'s own about page, as the agent and a person ask it. */
export const requestOf = (taskId: string, page: string = OWN_PAGE): Detail => ({
  taskId,
  page,
  ...WORDS,
});

/**
 * The owner's task proposed and approved by them, and picked up by the agent.
 * With `lineageId`, the proposal is a new version of that lineage's plan,
 * which retires the earlier version's lease and its delegation.
 */
export async function workOn(taskId: string, lineageId?: string): Promise<Work> {
  const proposal = await propose(s, taskId, {
    purpose: freshPurpose(),
    ...(lineageId === undefined ? {} : { lineageId }),
  });
  const decision = await approve(s, proposal);
  return { taskId, proposal, decision, picked: await pickup(s, decision['reservationId']) };
}

/** The agent's own request at the door, under the work's delegation. */
export const requestAsAgent = async (work: Work, body: Detail): Promise<Answer> =>
  await asWorker(agentDoor(), work, 'live_correction/request', {
    operationId: randomUUID(),
    ...body,
  });

/** A correction asked under an earlier lease on its task: its id, task, and its plan's lineage. */
export interface Earlier {
  readonly id: string;
  readonly taskId: string;
  readonly lineageId: string;
}

/** A correction the agent asked on its own task, under a lease a new version of its plan retires. */
export async function anEarlierLeasesCorrection(): Promise<Earlier> {
  const work = await workOn(await createTask(s, 'an earlier lease'));
  const asked = await requestAsAgent(work, requestOf(work.taskId));
  if (asked.status !== 200) throw new Error(`setup: request ${JSON.stringify(asked.body)}`);
  const id = String((asked.body['detail'] as Detail | undefined)?.['correctionId']);
  return { id, taskId: work.taskId, lineageId: String(work.proposal['lineageId']) };
}

export interface CorrectionRow {
  readonly id: string;
  readonly state: string;
  readonly party_id: string | null;
  readonly base_revision: string | null;
  readonly version_id: string | null;
  readonly pre_image_digest: string | null;
  readonly requested_by_actor_id: string;
  readonly requested_by_person_id: string;
  readonly delegation_id: string | null;
  readonly page_url: string;
  readonly word: string;
  readonly replacement: string;
}

export const correctionsOn = async (taskId: string): Promise<readonly CorrectionRow[]> =>
  await rows<CorrectionRow>(
    s,
    `select id::text as id, state, party_id::text as party_id, base_revision,
            version_id::text as version_id, pre_image_digest,
            requested_by_actor_id::text as requested_by_actor_id,
            requested_by_person_id::text as requested_by_person_id,
            delegation_id::text as delegation_id, page_url, word, replacement
       from public.live_corrections where task_id = $1`,
    [taskId],
  );

export const delegationOfLease = async (leaseId: unknown): Promise<string | undefined> =>
  (
    await rows<{ id: string }>(
      s,
      'select delegation_id::text as id from public.leases where business_id = $1 and id = $2',
      [s.business, leaseId],
    )
  )[0]?.id;

export const receiptsOf = async (correctionId: string): Promise<number> =>
  Number(
    (
      await rows<{ n: number }>(
        s,
        'select count(*)::int as n from public.live_correction_receipts where correction_id = $1',
        [correctionId],
      )
    )[0]?.n,
  );

/** A turn on the work's lease, offering the agent's catalogue. */
const turnBody = (work: Work, turnOrdinal: number, parts: readonly unknown[]) => ({
  operationId: randomUUID(),
  leaseId: work.picked['leaseId'],
  fence: work.picked['fence'],
  operation: REPLAY_TURN.key,
  kind: 'turn',
  turnOrdinal,
  tools: AGENT_TOOLS,
  parts,
});

/** The run's task at its current revision. */
export const taskPart = async (work: Work): Promise<Detail> => ({
  ref: 'task',
  taskId: work.taskId,
  revision: await revisionOf(s, work.taskId),
});

/** A turn, with the provider's sends it made counted. */
export async function turn(
  work: Work,
  turnOrdinal: number,
  parts: readonly unknown[],
): Promise<{ readonly answer: Answer; readonly sent: number }> {
  const seen = world.provider.seen.length;
  const answer = await asWorker(
    agentDoor(),
    work,
    'model/call',
    turnBody(work, turnOrdinal, parts),
  );
  return { answer, sent: world.provider.seen.length - seen };
}

/** Turn 0: the task, answered with a correction asked with `args`. Its answer's detail. */
export async function askedTurn(work: Work, args: Detail): Promise<Detail> {
  const call = { id: 'call_1', name: 'live_correction.request', args };
  world.provider.script([replied('Asking.', [call])]);
  const { answer } = await turn(work, 0, [await taskPart(work)]);
  const detail = (answer.body['detail'] ?? {}) as Detail;
  if (detail['state'] !== 'settled') {
    throw new Error(`setup: turn 0 did not settle: ${JSON.stringify(answer.body)}`);
  }
  return detail;
}

/** An earlier answer, carried back with the bytes the broker returned. */
export const answerPart = (detail: Detail): Detail => ({
  ref: 'answer',
  callId: detail['callId'],
  text: detail['text'],
  toolCalls: detail['toolCalls'],
});

/** Turn 1 on the work: its turn 0's ask, then `correctionId` as that request's result. */
export async function namingCorrection(
  work: Work,
  correctionId: string,
): Promise<{ readonly answer: Answer; readonly sent: number }> {
  const first = await askedTurn(work, requestOf(work.taskId));
  world.provider.script([replied('Done.')]);
  return await turn(work, 1, [
    await taskPart(work),
    answerPart(first),
    { ref: 'correction', correctionId, toolCallId: 'call_1' },
  ]);
}
