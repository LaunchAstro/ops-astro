// SPDX-License-Identifier: AGPL-3.0-only
//
// A record-scoped `task:read` grant on a map covers the map's tickets (W12):
// `task.read` admits each ticket one by one. The list helpers answer the same
// tickets, and so do the list reads built on them, `task.board` and
// `definition.attribution`. A second map's ticket, and a map filed under the
// granted one, stay out.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { coveredScopes } from '../../packages/core-records/src/authority/covered-scopes.ts';
import { subjectsOf, type Subject } from '../../packages/core-records/src/authority/grants.ts';
import {
  readableRecordIds,
  readableScope,
} from '../../packages/core-records/src/authority/readable-scope.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type Member,
  type WayfinderWorld,
} from '../wayfinder/world.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;
const DIGEST = 'b'.repeat(64);
let w: WayfinderWorld;
let owner: Decider;
let reader: Member;
let mapA: Made;
let ticketA: Made;
let ticketB: Made;
let nested: Made;
let taskTypeId: string;

/** A planned run on the task, its pin, and its entry read of `DIGEST`. */
async function runReading(taskId: string): Promise<string> {
  must(
    await w.as(owner, {
      command: 'task.propose',
      recordId: taskId,
      expectedRevision: await w.revisionOf(taskId),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 2_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
    'propose',
  );
  const [run] = await w.db.admin.execute<{ readonly id: string }>(
    `select id from public.planned_runs where business_id = $1 and task_id = $2`,
    [w.business, taskId],
  );
  if (run === undefined) throw new Error('propose planned no run');
  await w.db.admin.execute(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', 'skills/brief/SKILL.md', $3, 1, now(), '[]', $3, $4)`,
    [w.business, run.id, DIGEST, owner.actorId],
  );
  await w.db.admin.execute(
    `insert into public.bootstrap_reads
       (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
     values ($1, $2, $3, 1, 'skills/brief/SKILL.md', $4, 1, true)`,
    [w.business, randomUUID(), run.id, DIGEST],
  );
  return run.id;
}

async function asReader<T>(
  work: (tx: TenantQuery, subjects: readonly Subject[]) => Promise<T>,
): Promise<T> {
  return await w.db.app.withBusiness(w.business, async (tx) => {
    const standing = await resolveLogin(tx, reader.presented);
    if ('refused' in standing) throw new Error('reader refused');
    return await work(tx, subjectsOf(standing));
  });
}

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await wayfinderWorld('mapgrantlists', 'mapgrantlists');
  owner = await w.decider('owner');
  mapA = await w.create(owner, { title: 'Map A' }, { taskType: 'map' });
  const mapB = await w.create(owner, { title: 'Map B' }, { taskType: 'map' });
  ticketA = await w.create(owner, { title: 'Ticket A' }, { taskType: 'task', parentId: mapA.id });
  ticketB = await w.create(owner, { title: 'Ticket B' }, { taskType: 'task', parentId: mapB.id });
  nested = await w.create(owner, { title: 'Nested map' }, { taskType: 'map', parentId: mapA.id });
  reader = await w.member('map reader', ['read'], { kind: 'record', id: mapA.id });
  const [type] = await w.db.admin.execute<{ readonly id: string }>(
    `select id from public.record_types where business_id = $1 and key = 'task'`,
    [w.business],
  );
  taskTypeId = type?.id ?? '';
}, 180_000);

afterAll(async () => await w?.drop());

it('task.read admits the map ticket, and refuses the second map ticket and the nested map', async () => {
  const read = async (recordId: string) =>
    codeOf(await w.read(reader, { read: 'task.read', recordId }));
  expect(await read(ticketA.id)).toBe('applied');
  expect(await read(ticketB.id)).toBe('SCOPE_NOT_GRANTED');
  expect(await read(nested.id)).toBe('SCOPE_NOT_GRANTED');
});

it('readableScope and coveredScopes list the map and its ticket, never the second map or the nested map', async () => {
  const expected = { business: false, records: [mapA.id, ticketA.id].toSorted() };
  await asReader(async (tx, subjects) => {
    const scope = await readableScope(tx, subjects, 'task', 'read');
    expect({ ...scope, records: scope.records.toSorted() }).toEqual(expected);
    const covered = await coveredScopes(tx, subjects, { collection: 'task', action: 'read' });
    expect({ ...covered, records: covered.records.toSorted() }).toEqual(expected);
  });
});

it('readableRecordIds lists the map and its ticket, never the second map or the nested map', async () => {
  await asReader(async (tx, subjects) => {
    const ids = await readableRecordIds(tx, subjects, {
      collection: 'task',
      action: 'read',
      recordTypeId: taskTypeId,
    });
    expect(ids.toSorted()).toEqual([mapA.id, ticketA.id].toSorted());
  });
});

it('task.board shows the map reader the map ticket, never the second map ticket', async () => {
  const answer = (await w.read(reader, { read: 'task.board', board: null })) as {
    readonly tasks?: readonly { readonly id: string }[];
  };
  const shown = (answer.tasks ?? []).map((task) => task.id);
  expect(shown).toContain(ticketA.id);
  expect(shown).not.toContain(ticketB.id);
  expect(shown).not.toContain(nested.id);
});

it('definition.attribution names the run on the map ticket, never the run on the second map ticket', async () => {
  const runA = await runReading(ticketA.id);
  await runReading(ticketB.id);
  const answer = (await w.read(reader, { read: 'definition.attribution', digest: DIGEST })) as {
    readonly attribution?: { readonly runs: readonly { readonly runId: string }[] };
  };
  expect(answer.attribution?.runs.map((run) => run.runId)).toEqual([runA]);
}, 60_000);
