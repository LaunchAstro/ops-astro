// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one served API, the calls that share it */
//
// API-3 through the real entry: `node apps/cli/main.ts task ...` as its own
// process against the production server entry on its own port. The owner
// check's flow (a task, two subtasks, one blocked by the other, a comment, one
// resolved) runs from the terminal exactly as a person or agent would type it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

const ID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) r(\d+)\b/u;

function wrote(run: Run): { readonly id: string; readonly revision: string } {
  const match = ID.exec(run.stdout);
  if (run.code !== 0 || match === null) {
    throw new Error(`not a write: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return { id: match[1] as string, revision: match[2] as string };
}

describe.skipIf(serverUrl === undefined)('API-3 verbs as a separate process', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  const as = (token: string) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  });

  beforeAll(async () => {
    world = await createWorld('api3proc');
    scratch = mkdtempSync(join(tmpdir(), 'api-3-process-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('API-3 CLI help lists every verb and sends nothing', async () => {
    const run = await runCli(['help'], {});
    expect(run.code, run.stderr).toBe(0);
    for (const verb of ['task get', 'task list', 'task create', 'task link', 'map frontier']) {
      expect(run.stdout).toContain(verb);
    }
  });

  it('API-3 CLI owner check flow from the terminal', async () => {
    const env = as(world.ada.token);
    const parent = wrote(await runCli(['task', 'create', '--title', 'from the terminal'], env));
    const one = wrote(
      await runCli(['task', 'create', '--title', 'sub one', '--parent', parent.id], env),
    );
    const two = wrote(
      await runCli(['task', 'create', '--title', 'sub two', '--parent', parent.id], env),
    );
    wrote(
      await runCli(
        ['task', 'link', two.id, '--revision', two.revision, '--blocked-by', one.id],
        env,
      ),
    );
    const commented = wrote(
      await runCli(['task', 'comment', one.id, '--revision', one.revision, '--text', 'on it'], env),
    );
    wrote(
      await runCli(
        [
          'task',
          'resolve',
          one.id,
          '--revision',
          commented.revision,
          '--answer',
          'done',
          '--gist',
          'done',
        ],
        env,
      ),
    );
    const shown = await runCli(['task', 'get', two.id, '--detail', 'standard'], env);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`blockedBy: ${one.id}`);
    const refused = await runCli(['task', 'get', two.id], as(world.noah.token));
    expect(refused.code).toBe(1);
    expect(refused.stdout.trim().split('\n')).toHaveLength(1);
  }, 60_000);
});
