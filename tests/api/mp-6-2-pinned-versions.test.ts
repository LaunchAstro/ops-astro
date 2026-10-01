// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's pinned versions, the read half (CS-6.7): `task.read`'s proposal
// versions carry what their run was given at run start, the run's pin (kind,
// path, digest, size, read at) and its read ledger, through the real boundary
// and a fresh Postgres. The pin and the ledger are written by the writers on
// the branch, AW-02's `pinBootstrapFile` after a person's admitted activation
// and `readPinned` under the agent's live lease; the admin rows are the oracle.
// The crossings: another business, an external party of this business, and
// the agent under a live delegation on another task, each refused with no
// path, digest or version id in any body.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitActivation,
  captureManifest,
  pinBootstrapFile,
  readPinned,
} from '../../packages/core-runtime/src/index.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { encode, sourceOf } from '../runtime/aw-02-world.ts';
import { asAgent, asPerson, signed, type Signed } from './c54-fixture.ts';

const detailOf = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

// Bytes of this test's own, so their digests are in no other row.
const ENTRY = 'skills/pinned/SKILL.md';
const FRAGMENT = 'skills/pinned/notes.md';
const FILES = new Map([
  [ENTRY, encode(`# Pinned\n${randomUUID()}\n`)],
  [FRAGMENT, encode(`Notes ${randomUUID()}\n`)],
]);
const SIBLING = new Map([[ENTRY, encode(`# Sibling\n${randomUUID()}\n`)]]);

interface Work {
  readonly taskId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

interface VersionRead {
  readonly versionId: string;
  readonly pins?: unknown;
  readonly reads?: unknown;
}

// eslint-disable-next-line max-lines-per-function -- one world, the pins and each crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-2 pinned versions', () => {
  let world: World;
  let ada: Signed;
  let work: Work;

  /** A task whose plan ada approved and the agent picked up. */
  const pickedUp = async (title: string): Promise<Work> => {
    const task = await asPerson(world, ada, 'task.create', { fields: { title } });
    const taskId = String(task.body['recordId']);
    const proposed = await asPerson(world, ada, 'task.propose', {
      recordId: taskId,
      expectedRevision: Number(task.body['revision']),
      ...PROPOSAL,
    });
    const decided = await asPerson(world, ada, 'task.decide', {
      gateId: detailOf(proposed)['gateId'],
      versionId: detailOf(proposed)['versionId'],
      decision: 'approve',
      note: 'approved for a run that is given files',
    });
    const picked = await call(
      world.api,
      agentPath('alpha', '/task/pickup'),
      { operationId: randomUUID(), reservationId: detailOf(decided)['reservationId'] },
      bearer(world.agent.token),
    );
    expect(picked.code).toBe('ok');
    const lease = detailOf(picked);
    return {
      taskId,
      versionId: String(detailOf(proposed)['versionId']),
      runId: String(lease['runId']),
      leaseId: String(lease['leaseId']),
      fence: Number(lease['fence']),
      credential: String(lease['credential']),
    };
  };

  /** Ada's manual activation pins `files`' entry on the run, with every file in the manifest. */
  const pin = async (on: Work, files: ReadonlyMap<string, Uint8Array>): Promise<void> => {
    const activation = admitActivation({
      mode: 'manual',
      activator: { kind: 'person', actorId: ada.actorId },
    });
    if (!activation.ok) throw new Error('activation refused');
    const manifest = await captureManifest(sourceOf(files), [...files.keys()]);
    if (!manifest.ok) throw new Error('manifest refused');
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const pinned = await pinBootstrapFile(tx, activation.value, {
        runId: on.runId,
        entryPath: ENTRY,
        manifest: manifest.value,
      });
      expect(pinned.ok).toBe(true);
    });
  };

  /** One pinned read under the agent's live lease, its audit note dropped. */
  const readFile = async (
    on: Work,
    path: string,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<void> => {
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const read = await readPinned(
        tx,
        {
          leaseId: on.leaseId,
          holderActorId: world.agent.actorId,
          runId: on.runId,
          stepId: null,
          path,
        },
        sourceOf(files),
        async () => {
          await Promise.resolve();
        },
      );
      expect(read.ok).toBe(true);
    });
  };

  const handBack = async (on: Work): Promise<void> => {
    const back = await asAgent(
      world,
      'task.handback',
      { leaseId: on.leaseId, fence: on.fence, outcome: 'completed', report: { wrote: 'done' } },
      on.credential,
    );
    expect(back.code).toBe('ok');
  };

  const versionRead = async (): Promise<VersionRead | undefined> => {
    const read = await asPerson(world, ada, 'task.read', { recordId: work.taskId });
    const proposals = (read.body['task'] as { proposals: unknown }).proposals as readonly {
      readonly versions: readonly VersionRead[];
    }[];
    return proposals.flatMap((p) => p.versions).find((v) => v.versionId === work.versionId);
  };

  /** The run's pin and ledger as stored, read as admin, in the view's spelling. */
  const stored = async (
    runId: string,
  ): Promise<{ readonly pins: unknown[]; readonly reads: { readonly path: string }[] }> => {
    const pins = await world.db.admin.execute<{
      readonly path: string;
      readonly content_digest: string;
      readonly content_size: string;
      readonly read_at: Date;
      readonly pinned_at: Date;
    }>(
      `select path, content_digest, content_size::text, read_at, pinned_at
         from public.run_definition_pins where run_id = $1`,
      [runId],
    );
    const ledger = await world.db.admin.execute<{
      readonly sequence: number;
      readonly path: string;
      readonly content_digest: string;
      readonly content_size: string;
      readonly read_at: Date;
      readonly is_entry: boolean;
    }>(
      `select sequence, path, content_digest, content_size::text, read_at, is_entry
         from public.bootstrap_reads where run_id = $1 order by sequence`,
      [runId],
    );
    return {
      pins: pins.map((row) => ({
        kind: 'bootstrap_file',
        path: row.path,
        digest: row.content_digest,
        size: Number(row.content_size),
        readAt: row.read_at.toISOString(),
        definitionVersionId: null,
        pinnedAt: row.pinned_at.toISOString(),
      })),
      reads: ledger.map((row) => ({
        sequence: row.sequence,
        path: row.path,
        digest: row.content_digest,
        size: Number(row.content_size),
        readAt: row.read_at.toISOString(),
        isEntry: row.is_entry,
      })),
    };
  };

  beforeAll(async () => {
    world = await createWorld('mp62pins');
    ada = signed(world.ada);
    // Another task's run is pinned and read first: its pin and ledger are in
    // this business, not on this run.
    const sibling = await pickedUp('another task whose run is given a file');
    await pin(sibling, SIBLING);
    await readFile(sibling, ENTRY, SIBLING);
    await handBack(sibling);
    work = await pickedUp('a run that is given files');
  }, 180_000);

  afterAll(async () => await world?.close());

  it('MP-6-2 pinned versions: a run reads what was pinned at its start and each file it read, as stored', async () => {
    const before = await versionRead();
    expect(before?.pins).toEqual([]);
    expect(before?.reads).toEqual([]);

    await pin(work, FILES);
    await readFile(work, ENTRY, FILES);
    await readFile(work, FRAGMENT, FILES);

    const { pins, reads } = await stored(work.runId);
    expect(pins).toHaveLength(1);
    expect(reads.map((read) => read.path)).toEqual([ENTRY, FRAGMENT]);

    const after = await versionRead();
    expect(after?.pins).toEqual(pins);
    expect(after?.reads).toEqual(reads);
    await handBack(work);
  });

  it('MP-6-2 pinned versions isolation: another business, an external party and the agent on another task read no pin of this run', async () => {
    const [row] = await world.db.admin.execute<{ readonly content_digest: string }>(
      'select content_digest from public.run_definition_pins where run_id = $1',
      [work.runId],
    );
    const digest = String(row?.content_digest);
    const carriesNothing = (answer: Answer): void => {
      expect(answer.code).not.toBe('ok');
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(work.versionId);
      expect(text).not.toContain(digest);
      expect(text).not.toContain(ENTRY);
    };
    const bea = signed(world.bea);
    const across = await asPerson(world, bea, 'task.read', { recordId: work.taskId });
    const madeUp = await asPerson(world, bea, 'task.read', { recordId: randomUUID() });
    expect(across.status).toBe(404);
    expect(across.body).toEqual(madeUp.body);
    carriesNothing(across);
    const external = await enrolExternal(world);
    carriesNothing(
      await call(
        world.api,
        personPath('alpha', '/task/read'),
        { recordId: work.taskId },
        bearer(external.token),
      ),
    );
    const other = await pickedUp('the agent’s other task');
    carriesNothing(await asAgent(world, 'task.read', { recordId: work.taskId }, other.credential));
  });
});
