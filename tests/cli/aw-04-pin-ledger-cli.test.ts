// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04 (#816), moved from AW-02: "the command line lists a run's pin and
// ledger at parity with the app and API". A run's node on `task.execution`
// names the instruction file it ran with, by digest and size, and every file
// it read, in read order, with the path-sorted set digest. The command line
// is its own process against the served API, and its answer is the app
// route's, byte for byte.
//
// The pin and the ledger rows are written here as `acceptPlan` and
// `readPinned` write them (`tests/runtime/aw-04-plan-accept.test.ts` proves
// those writes); what this file proves is the read of them on each surface.

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { setDigest } from '../../packages/core-runtime/src/index.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

const ENTRY = { path: 'brief.md', bytes: '# Brief\nDraft the reply.\n' };
const FRAGMENT = { path: 'notes/tone.md', bytes: 'Plain words.\n' };

const identity = (file: { path: string; bytes: string }) => ({
  path: file.path,
  digest: createHash('sha256').update(file.bytes).digest('hex'),
  size: Buffer.byteLength(file.bytes),
});

type Graph = { nodes: readonly { nodeId: string; definition?: unknown }[] };

describe.skipIf(serverUrl === undefined)('AW-04 pin and ledger on the command line', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  beforeAll(async () => {
    world = await createWorld('cliaw04pin');
    scratch = mkdtempSync(join(tmpdir(), 'cli-aw04-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  const person = async (name: 'task.create' | 'task.propose' | 'task.execution', body: object) =>
    await call(
      world.api,
      personPath('alpha', pathOf(name)),
      { ...(name === 'task.execution' ? {} : { operationId: randomUUID() }), ...body },
      bearer(world.ada.token),
    );

  async function pinnedRun(): Promise<{ taskId: string; runId: string }> {
    const created = await person('task.create', { fields: { title: 'a pinned run' } });
    const taskId = String(created.body['recordId']);
    const proposed = await person('task.propose', {
      recordId: taskId,
      expectedRevision: Number(created.body['revision']),
      purpose: 'draft_the_reply',
      maximumMinor: 1_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    const runId = String((proposed.body['detail'] as Record<string, unknown>)['runId']);
    const [entry, fragment] = [identity(ENTRY), identity(FRAGMENT)];
    const manifest = [entry, fragment];
    await world.db.admin.execute(
      `insert into public.run_definition_pins (business_id, run_id, ref_kind, path,
         content_digest, content_size, read_at, manifest, manifest_digest, pinned_by_actor_id)
       values ($1, $2, 'bootstrap_file', $3, $4, $5, now(), $6::text::jsonb, $7, $8)`,
      [
        world.alpha,
        runId,
        entry.path,
        entry.digest,
        entry.size,
        JSON.stringify(manifest),
        setDigest(manifest).digest,
        world.ada.actorId,
      ],
    );
    for (const [index, read] of [entry, fragment, entry].entries()) {
      // eslint-disable-next-line no-await-in-loop -- the ledger's own order
      await world.db.admin.execute(
        `insert into public.bootstrap_reads (business_id, id, run_id, sequence, path,
           content_digest, content_size, is_entry)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          world.alpha,
          randomUUID(),
          runId,
          index + 1,
          read.path,
          read.digest,
          read.size,
          index === 0,
        ],
      );
    }
    return { taskId, runId };
  }

  it('AW-04 pin and ledger on the command line: a run names its pinned file and every read, as the app route does', async () => {
    const { taskId, runId } = await pinnedRun();
    const [entry, fragment] = [identity(ENTRY), identity(FRAGMENT)];

    const cli = await runCli(['task.execution', '--json', JSON.stringify({ recordId: taskId })], {
      OPS_ASTRO_API_URL: (api as ServedApi).origin,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: world.ada.token,
      OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    });
    expect(cli.code, cli.stderr).toBe(0);
    const http = await person('task.execution', { recordId: taskId });
    expect(http.status).toBe(200);
    // Parity: the command line prints the route's answer whole.
    expect(cli.json).toStrictEqual(http.body);

    const graph = (http.body['execution'] as { graph: Graph }).graph;
    const node = graph.nodes.find((one) => one.nodeId === runId);
    expect(node?.definition).toStrictEqual({
      kind: 'bootstrap_file',
      path: entry.path,
      versionId: null,
      digest: entry.digest,
      size: entry.size,
      manifestDigest: setDigest([entry, fragment]).digest,
      reads: [
        { sequence: 1, entry: true, ...entry },
        { sequence: 2, entry: false, ...fragment },
        { sequence: 3, entry: false, ...entry },
      ],
      readSet: setDigest([entry, fragment]),
    });
  });

  it('AW-04 pin and ledger on the command line: a run with no pin says so, never an empty pin', async () => {
    const created = await person('task.create', { fields: { title: 'an unpinned run' } });
    const taskId = String(created.body['recordId']);
    await person('task.propose', {
      recordId: taskId,
      expectedRevision: Number(created.body['revision']),
      purpose: 'draft_the_reply',
      maximumMinor: 1_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    const read = await person('task.execution', { recordId: taskId });
    const graph = (read.body['execution'] as { graph: Graph }).graph;
    expect(graph.nodes.map((node) => node.definition)).toStrictEqual([null]);
  });
});
