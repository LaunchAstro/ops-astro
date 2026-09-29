// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-15 through the command line, each call its own process (the owner's
// check: ask for a task to be completed and then reopened from the command
// line; it shows done, then open again, with its unfinished steps back). The
// one completion transition is `task.complete` and `task.reopen` on every
// surface, so the command line reaches the same act the board tick does.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

interface Step {
  readonly id: string;
  readonly done: boolean;
  readonly archived: unknown;
}

function written(run: Run): { readonly recordId: string; readonly revision: number } {
  const body = run.json;
  if (run.code !== 0 || body === undefined || typeof body['recordId'] !== 'string') {
    throw new Error(`not a write answer: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return { recordId: body['recordId'], revision: Number(body['revision']) };
}

let world: World;
let api: ServedApi | undefined;

const as = (token: string) => ({
  OPS_ASTRO_API_URL: (api as ServedApi).origin,
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_TOKEN: token,
});

const cli = async (command: string, body: Readonly<Record<string, unknown>>) =>
  await runCli([command, '--json', JSON.stringify(body)], as(world.ada.token));

const read = async (recordId: string) => {
  const run = await cli('task.read', { recordId });
  expect(run.code, run.stderr).toBe(0);
  return run.json?.['task'] as {
    readonly revision: number;
    readonly completedAt: string | null;
    readonly steps: readonly Step[];
  };
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await createWorld('mp415');
  api = await serveApi(world);
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await world?.close();
}, 60_000);

describe.skipIf(serverUrl === undefined)(
  'MP-4-15 complete and reopen from the command line',
  () => {
    it('the steps are archived on completion and back, unfinished, on reopen', async () => {
      const parent = written(
        await cli('task.create', { fields: { title: `launch ${randomUUID()}` } }),
      );
      const open = written(
        await cli('task.create', { fields: { title: 'open step' }, parentId: parent.recordId }),
      );
      const done = written(
        await cli('task.create', { fields: { title: 'done step' }, parentId: parent.recordId }),
      );
      written(
        await cli('task.complete', { recordId: done.recordId, expectedRevision: done.revision }),
      );

      const before = await read(parent.recordId);
      written(
        await cli('task.complete', {
          recordId: parent.recordId,
          expectedRevision: before.revision,
        }),
      );
      const completed = await read(parent.recordId);
      expect(completed.completedAt).not.toBeNull();
      const archived = completed.steps.find((step) => step.id === open.recordId);
      expect(archived?.done).toBe(false);
      expect(archived?.archived).not.toBeNull();

      written(
        await cli('task.reopen', {
          recordId: parent.recordId,
          expectedRevision: completed.revision,
          reason: 'More to do',
        }),
      );
      const reopened = await read(parent.recordId);
      expect(reopened.completedAt).toBeNull();
      const back = reopened.steps.find((step) => step.id === open.recordId);
      expect(back).toMatchObject({ done: false, archived: null });
      expect(reopened.steps.find((step) => step.id === done.recordId)?.done).toBe(true);
    }, 90_000);
  },
);
