// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved on the path the positive fixtures miss for
// a map (wayfinder S7, #1297): each fixture writes on an ordinary task, but the
// ordinary task commands take a ticket too, and a write to a ticket's row or a
// link to it fires the records and links triggers that refresh its map's
// summary and frontier (`map_summary_on_record`, `map_summary_on_link`). Here
// each command's own positive recipe runs again with every fresh task it makes
// filed as an open, unassigned ticket under one live map; a move, which a
// ticket refuses, acts on a map itself. Each act runs alone, must answer ok, must
// refresh both tables, and must write nothing its entry does not declare.
// A comment names its task outside the parent slot the trigger reads, so the
// comment commands refresh no map and are not here. The map commands declare
// the read model already (`data-effects-wayfinder.ts`) and the purge's
// live-map path is `s0-5-effect-purge-path`. A change request's task is made
// under the review's own task (#2117), so its review is opened on the map.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-wire/src/index.ts';
import { WAYFINDER_EFFECTS } from '../../packages/core-wire/src/data-effects-wayfinder.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { PROPOSAL, type Task } from '../acceptance/role-case-bodies.ts';
import { serverUrl } from '../acceptance/world.ts';
import { ABOUT_FILE } from '../site/party-site-fixture.ts';
import { pathFaults } from './s0-5-effect-diff.ts';

/** The ordinary task commands that write a ticket's row or a link to it, each on a ticket. */
const ON_A_TICKET: readonly CommandName[] = [
  'task.create',
  'task.update',
  'task.complete',
  'task.reopen',
  'task.start',
  'task.assign',
  'task.triage',
  'task.set_stage',
  'task.set_state',
  'task.set_scores',
  'task.set_adhoc',
  'task.set_category',
  'task.duplicate',
  'task.set_party',
  'task.restore',
  'task.set_audience',
  'task.reparent',
  'task.rank',
  'task.trash',
  'review.make_change_task',
];

/**
 * A subtask is on its parent's board, so a ticket refuses a move
 * PLACEMENT_IS_DERIVED (`tasks-place.ts`); the move is the map's own, which
 * writes the map's row.
 */
const ON_THE_MAP: readonly CommandName[] = ['task.move'];

/**
 * What a ticket accepts in place of a recipe's fields. A map and its tickets
 * never reach a client surface (WF-1), so a ticket refuses `client_visible:
 * true` TRANSITION_NOT_PERMITTED and its audience is set internal. A subtask is
 * held to its parent's client (`tasks-party.ts`), so a ticket under a map with
 * no client takes none.
 */
const ON_A_TICKET_FIELDS: Partial<Record<CommandName, Record<string, unknown>>> = {
  'task.set_audience': { client_visible: false },
  'task.set_party': { client: null },
};

const MAP_READ_MODEL = ['map_summaries', 'map_frontier'];

let harness: Harness;
let liveMap: string | undefined;

/** A fresh open, unassigned ticket under the one live map every path shares. */
async function freshTicket(title: string): Promise<Task> {
  liveMap ??= String(
    (await harness.asPerson('task.create', { fields: { title: 'a live map' }, taskType: 'map' }))
      .body['recordId'],
  );
  const made = await harness.asPerson('task.create', { fields: { title }, parentId: liveMap });
  if (made.code !== 'ok') throw new Error(`a ticket under the map refused ${made.code}`);
  return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
}

function declared(name: CommandName): CommandDeclaration {
  const declaration = COMMAND_SURFACE.find((one) => one.name === name);
  if (declaration === undefined) throw new Error(`${name} is not in the surface`);
  return declaration;
}

/** The command's positive recipe on tickets, as the act; a create files its own ticket. */
async function onATicket(name: CommandName): Promise<() => Promise<string>> {
  const prepared = await harness.positiveBodyOn(freshTicket)(declared(name));
  if ('exception' in prepared) throw new Error(`${name}: no fixture (${prepared.exception})`);
  // An open ticket the act does not touch, so the map's frontier is never empty before or after.
  await freshTicket('a ticket the frontier keeps');
  const fields = ON_A_TICKET_FIELDS[name];
  const body = {
    ...prepared.body,
    ...(name === 'task.create' ? { parentId: liveMap } : {}),
    ...(fields === undefined ? {} : { fields }),
  };
  return async () => (await harness.asPerson(name, body)).code;
}

/** A refusal names the step it stopped at. */
async function ok(name: CommandName, body: Record<string, unknown>) {
  const answer = await harness.asPerson(name, body);
  if (answer.code !== 'ok') throw new Error(`${name} refused ${answer.code}`);
  return answer.body['detail'] as Readonly<Record<string, unknown>>;
}

/** A page of the business's own site, bound (a map takes no client). */
async function ownSitePage(): Promise<string> {
  const site = randomUUID().slice(0, 8);
  const pageUrl = `https://own-${site}.example/about`;
  const actorId = String(harness.world.ada.actorId);
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    const own = { partyId: null, repository: `own/site-${site}`, defaultBranch: 'main' };
    const pages = [{ pageUrl, path: ABOUT_FILE }];
    const bound = await bindPartySite(tx, { ...own, project: `prj_own_${site}`, pages }, actorId);
    if (!bound.ok) throw new Error(`the own site refused ${bound.code}`);
  });
  return pageUrl;
}

/** The admin's own lease on `taskId` (EX-01): a proposal approved, then picked up. */
async function adminLease(taskId: string) {
  const read = await harness.asPerson('task.read', { recordId: taskId });
  const gate = await ok('task.propose', {
    recordId: taskId,
    expectedRevision: (read.body['task'] as { readonly revision: number }).revision,
    ...PROPOSAL,
  });
  const approved = await ok('task.decide', {
    gateId: gate['gateId'],
    versionId: gate['versionId'],
    decision: 'approve',
    note: 'approved so the request can be made a task',
  });
  return await ok('task.pickup', { reservationId: approved['reservationId'] });
}

/**
 * A change request's task is made under the review's task, so the review is opened on a live map
 * holding one open ticket, on the business's own site. Its client pin is filed and approved, and
 * the admin's lease on the map makes the task: a ticket of the map.
 */
async function changeTaskOnAMap(): Promise<() => Promise<string>> {
  const made = await harness.asPerson('task.create', {
    fields: { title: 'a map a review is opened on' },
    taskType: 'map',
  });
  const mapId = String(made.body['recordId']);
  await harness.asPerson('task.create', { fields: { title: 'an open ticket' }, parentId: mapId });
  const pageUrl = await ownSitePage();
  const opened = await ok('review.open', {
    taskId: mapId,
    pageUrl,
    path: ABOUT_FILE,
    sourceRevision: `rev-${randomUUID().slice(0, 8)}`,
  });
  const { revisionId } = opened;
  await ok('review.capture', { revisionId });
  const spot = { type: 'FragmentSelector', conformsTo: 'http://www.w3.org/TR/media-frags/' };
  const pinned = await ok('review.pin_comment', {
    revisionId,
    width: 1480,
    selector: [{ ...spot, value: 'xywh=0,0,9,9' }],
    body: 'a pin',
    audience: 'client',
  });
  const filed = await ok('review.propose_change', {
    commentId: pinned['commentId'],
    text: 'a change',
  });
  const { changeRequestId } = filed;
  await ok('review.decide_change', { changeRequestId, decision: 'approve' });
  const lease = await adminLease(mapId);
  const body = { leaseId: lease['leaseId'], fence: lease['fence'], changeRequestId };
  return async () => (await harness.asPerson('review.make_change_task', body)).code;
}

/** The command's positive recipe aimed at a fresh map holding one open ticket. */
async function onTheMap(name: CommandName): Promise<() => Promise<string>> {
  const prepared = await harness.positiveBody(declared(name));
  if ('exception' in prepared) throw new Error(`${name}: no fixture (${prepared.exception})`);
  const made = await harness.asPerson('task.create', {
    fields: { title: `a map for ${name}` },
    taskType: 'map',
  });
  const mapId = String(made.body['recordId']);
  const ticket = await harness.asPerson('task.create', {
    fields: { title: 'its open ticket' },
    parentId: mapId,
  });
  if (made.code !== 'ok' || ticket.code !== 'ok') throw new Error(`${name}: no map to act on`);
  const read = await harness.asPerson('task.read', { recordId: mapId });
  const expectedRevision = (read.body['task'] as { readonly revision: number }).revision;
  const body = { ...prepared.body, recordId: mapId, expectedRevision };
  return async () => (await harness.asPerson(name, body)).code;
}

describe.skipIf(serverUrl === undefined)(
  'S0-5 effect metadata: a task command on a ticket or its map',
  () => {
    beforeAll(async () => {
      harness = await createHarness('s05_map');
    }, 180_000);

    afterAll(async () => {
      await harness?.close();
    });

    it.each(ON_A_TICKET)(
      '%s on a ticket declares the map summary and frontier it refreshes',
      async (name) => {
        const prepare = () =>
          name === 'review.make_change_task' ? changeTaskOnAMap() : onATicket(name);
        const path = { name, code: 'ok', drives: MAP_READ_MODEL, prepare };
        expect(await pathFaults(harness.world.db.admin, path)).toStrictEqual([]);
      },
      120_000,
    );

    it.each(ON_THE_MAP)(
      '%s on a map declares the summary and frontier it refreshes',
      async (name) => {
        const path = { name, code: 'ok', drives: MAP_READ_MODEL, prepare: () => onTheMap(name) };
        expect(await pathFaults(harness.world.db.admin, path)).toStrictEqual([]);
      },
      120_000,
    );

    it('every other command declaring the map read model is a map command or the purge', () => {
      const declaring = COMMAND_SURFACE.map(({ name }) => name).filter(
        (name) =>
          !(name in WAYFINDER_EFFECTS) &&
          name !== 'task.purge' &&
          COMMAND_EFFECTS[name].writes.some(({ kind }) => MAP_READ_MODEL.includes(kind)),
      );
      expect(declaring.toSorted()).toStrictEqual([...ON_A_TICKET, ...ON_THE_MAP].toSorted());
    });
  },
);
