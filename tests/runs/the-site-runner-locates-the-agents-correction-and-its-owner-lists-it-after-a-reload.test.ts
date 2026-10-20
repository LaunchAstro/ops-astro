// SPDX-License-Identifier: AGPL-3.0-only
//
// #2053 (#1624 R7b): the correction the shipped agent runner drafts goes the
// whole way a person's does. The site runner's own locate pass (`locatePass`
// over `custodySites(...).locate()`, #1693), configured for the business's own
// site and reading its file through custody's source double, pins the agent's
// row; a runner configured for a client's site in the same business, or the
// same configuration run for another business, leaves it and sends nothing. Then `live_correction.list`,
// read fresh as a reload reads it, answers the pinned row to the owner at its
// version, and to no reader out of reach: a member without read on the task,
// a member whose run grant is a client's, and another business's owner. No
// such answer carries the row's id, version or task. The web card draws a
// listed correction it did not request on a fresh mount (#1695,
// `tests/web/correction-cards-follow.test.tsx`).

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { locatePass } from '../../apps/site-runner/locate.ts';
import type { Passed } from '../../apps/site-runner/runner.ts';
import { custodySites } from '../../apps/site-runner/sites.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { contentDigest, REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { ConfiguredSite } from '../../packages/core-records/src/site/locate.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { addClient, enrol, grantTo, type Member } from '../commands/fixture.ts';
import { seedSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { HEAD_COMMIT, sourceDouble } from '../site/locate-world.ts';
import { acceptedPlan } from './compute-seam-world.ts';
import {
  agentBroker,
  correctionsOn,
  OWN_PAGE,
  ownSiteOf,
  replied,
  requestOf,
  type CorrectionRow,
} from './agent-draft-world.ts';
import { s, useStopWorld, world } from './run-stop-world.ts';

useStopWorld('r7blocate');

/** The about page's file on the own site's default branch, with the misspelt town in it. */
const BEFORE = '---\ntitle: About\n---\n\nWe are a Townsvile studio.\n';
const ABOUT = 'src/pages/about.md';

let own: ConfiguredSite;
let client: ConfiguredSite;
let other: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  own = await ownSiteOf(s, OWN_PAGE);
  other = await seedSchedules(s.db, 'r7blocate-other', 1_000_000);
  await ownSiteOf(other, `https://other-${randomUUID().slice(0, 8)}.example/about`);
  const partyId = randomUUID();
  await addClient(s.db.app, s.business, partyId, s.decider);
  client = await s.db.app.withBusiness(s.business, async (tx) => {
    const site = {
      partyId,
      repository: `client/site-${partyId.slice(0, 8)}`,
      defaultBranch: 'main',
      project: `prj_client_${partyId.slice(0, 8)}`,
      pages: [{ pageUrl: `https://client-${partyId.slice(0, 8)}.example/about`, path: ABOUT }],
    };
    const bound = await bindPartySite(tx, site, s.decider.actorId);
    if (!bound.ok) throw new Error(`setup: client site bind refused ${bound.code}`);
    return { ...site, holder: partyId };
  });
}, 180_000);

/** One pass of the site runner configured for `site` in `business`, its file read through custody. */
async function runnerPass(
  site: ConfiguredSite,
  business: BusinessId = s.business,
): Promise<{ readonly passed: readonly Passed[]; readonly requests: readonly string[] }> {
  const double = sourceDouble({ [ABOUT]: BEFORE });
  const ports = custodySites(double.ports, site).locate();
  const passed = await locatePass({ db: s.db.app, business, site, ports });
  return { passed, requests: double.requests };
}

/** The correction the shipped agent runner drafts on its own task, as stored: `locating`. */
async function draftedByAgent(): Promise<CorrectionRow> {
  const seam = await acceptedPlan(
    'the about page spells the town wrong',
    agentRunner({ operation: REPLAY_TURN.key }),
    agentBroker(),
  );
  const ask = { id: 'call_1', name: 'live_correction.request', args: requestOf(seam.taskId) };
  world.provider.script([replied('Asking.', [ask]), replied('Drafted for your decision.')]);
  const outcome = await seam.worker.applyOnce(seam.taskId);
  expect(outcome, JSON.stringify(outcome)).toHaveProperty('handedBack');
  const [drafted] = await correctionsOn(seam.taskId);
  if (drafted === undefined) throw new Error('the agent drafted nothing');
  expect(drafted).toMatchObject({ state: 'locating', version_id: null, base_revision: null });
  return drafted;
}

interface Stored extends CorrectionRow {
  readonly task_id: string;
}

const stored = async (id: string): Promise<Stored> => {
  const [row] = await s.db.admin.execute<Stored>(
    `select id::text as id, state, party_id::text as party_id, base_revision,
            version_id::text as version_id, pre_image_digest,
            requested_by_actor_id::text as requested_by_actor_id,
            requested_by_person_id::text as requested_by_person_id,
            delegation_id::text as delegation_id, page_url, word, replacement,
            task_id::text as task_id
       from public.live_corrections where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('the correction is gone');
  return row;
};

/** The agent's correction, pinned by the own site's runner. */
async function pinnedDraft(): Promise<Stored> {
  const drafted = await draftedByAgent();
  const { passed } = await runnerPass(own);
  expect(passed).toContainEqual({ correctionId: drafted.id, outcome: 'requested' });
  return await stored(drafted.id);
}

const listAs = async (member: Member, business: BusinessId = s.business) =>
  await executeRead(s.db.app, business, member.presented, { read: 'live_correction.list' });

const listedIds = (answer: unknown): readonly string[] =>
  ((answer as { corrections?: readonly { correctionId: string }[] }).corrections ?? []).map(
    (each) => each.correctionId,
  );

const carriesNone = (answer: unknown, markers: readonly (string | null)[]): void => {
  for (const marker of markers) {
    if (marker !== null) expect(JSON.stringify(answer)).not.toContain(marker);
  }
};

describe.skipIf(serverUrl === undefined)("the site runner's locate pass", () => {
  it("pins the agent's correction on the own site from the file it read at the head", async () => {
    const drafted = await draftedByAgent();
    const { passed, requests } = await runnerPass(own);
    expect(passed).toContainEqual({ correctionId: drafted.id, outcome: 'requested' });
    expect(requests).toHaveLength(2);
    const row = await stored(drafted.id);
    expect(row).toMatchObject({
      state: 'requested',
      base_revision: HEAD_COMMIT,
      pre_image_digest: contentDigest(BEFORE),
      requested_by_person_id: s.decider.personId,
      party_id: null,
    });
    expect(row.version_id).not.toBeNull();
    expect(row.delegation_id).not.toBeNull();
  }, 120_000);

  it("of a client's site, or of another business, leaves it and sends nothing", async () => {
    const drafted = await draftedByAgent();
    const before = await stored(drafted.id);
    const byClient = await runnerPass(client);
    const elsewhere = await runnerPass(own, other.business);
    for (const pass of [byClient, elsewhere]) {
      expect(pass.passed.map((each) => each.correctionId)).not.toContain(drafted.id);
      expect(pass.requests).toStrictEqual([]);
    }
    expect(await stored(drafted.id)).toStrictEqual(before);
    const { passed } = await runnerPass(own);
    expect(passed).toContainEqual({ correctionId: drafted.id, outcome: 'requested' });
  }, 120_000);
});

describe.skipIf(serverUrl === undefined)('live_correction.list after a reload', () => {
  it("answers the owner the agent's correction at the version the runner pinned", async () => {
    const pinned = await pinnedDraft();
    const answer = await listAs(s.decider);
    expect(answer).toMatchObject({ ok: true });
    const listed = (answer as { corrections: readonly unknown[] }).corrections;
    expect(listed).toContainEqual({
      correctionId: pinned.id,
      taskId: pinned.task_id,
      state: 'requested',
      approver: null,
      versionId: pinned.version_id,
      pageUrl: OWN_PAGE,
      word: pinned.word,
      replacement: pinned.replacement,
      requestedAt: expect.any(String),
    });
  }, 120_000);

  it('answers no reader out of reach, and names nothing of it', async () => {
    const pinned = await pinnedDraft();
    const markers = [pinned.id, pinned.version_id, pinned.task_id];
    const noTask = await enrol(s.db.app, s.business, 'r7b-no-task');
    const clientRun = await enrol(s.db.app, s.business, 'r7b-client-run');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, noTask, 'write', { kind: 'business', id: null }, false, 'run');
      await grantTo(tx, clientRun, 'write', { kind: 'party', id: client.holder }, false, 'run');
      await grantTo(tx, clientRun, 'read', { kind: 'record', id: pinned.task_id });
    });
    for (const answer of [
      await listAs(noTask),
      await listAs(clientRun),
      await listAs(other.decider, other.business),
    ]) {
      expect(answer).toStrictEqual({ ok: true, corrections: [] });
      carriesNone(answer, markers);
    }
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, noTask, 'read', { kind: 'record', id: pinned.task_id });
    });
    expect(listedIds(await listAs(noTask))).toContain(pinned.id);
  }, 120_000);
});
