// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 on the command line: `run.delegate_child`'s answer carries the
// helper's credential, which is saved beside the delegation file, readable by
// the owner only, and never printed; the parent's own saved credential stays.
// The helper's `run.child_handback` then works with the saved one. Each call
// is its own process against the served API, as in `cli-process.test.ts`.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

const PROPOSAL = {
  purpose: 'draft_the_reply',
  maximumMinor: 3_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'compose', payload: {} },
} as const;

function detailOf(run: Run): Record<string, unknown> {
  const detail = run.json?.['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw new Error(`no detail: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return detail as Record<string, unknown>;
}

// eslint-disable-next-line max-lines-per-function -- one world, one journey
describe.skipIf(serverUrl === undefined)("the helper's credential on the command line", () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  const env = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
    ...extra,
  });
  const read = (file: string): string => readFileSync(join(scratch, file), 'utf8').trim();

  beforeAll(async () => {
    world = await createWorld('cliaw11');
    // A hand-over is run:write inside the delegation, which the cast's admin
    // holds on no run; the pickup's delegation then reaches run.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, world.ada as Member, 'write', undefined, false, 'run');
    });
    scratch = mkdtempSync(join(tmpdir(), 'cli-aw11-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- pickup, hand-over and handback, in order
  it('AW-11 the hand-over saves the helper credential beside the delegation file, never printed', async () => {
    const person = env(world.ada.token);
    const created = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: 'a helped task' } })],
      person,
    );
    const task = created.json as { recordId: string; revision: number };
    const proposed = await runCli(
      [
        'task.propose',
        '--json',
        JSON.stringify({ recordId: task.recordId, expectedRevision: task.revision, ...PROPOSAL }),
      ],
      person,
    );
    const gate = detailOf(proposed);
    const decided = await runCli(
      [
        'task.decide',
        '--json',
        JSON.stringify({
          gateId: gate['gateId'],
          versionId: gate['versionId'],
          decision: 'approve',
          note: 'approved for the helper case',
        }),
      ],
      person,
    );
    const agent = env(world.agent.token, { OPS_ASTRO_AGENT: '1' });
    const picked = await runCli(
      [
        'task.pickup',
        '--json',
        JSON.stringify({ reservationId: detailOf(decided)['reservationId'] }),
      ],
      agent,
    );
    expect(picked.code, picked.stdout).toBe(0);
    const held = detailOf(picked);
    const parentCredential = read('delegation');

    const handed = await runCli(
      [
        'run.delegate_child',
        '--json',
        JSON.stringify({
          leaseId: held['leaseId'],
          fence: held['fence'],
          // The world has one agent login: it is its own helper here.
          helperActorId: world.agent.actorId,
          purpose: 'cli_helper',
          collections: ['task'],
          actions: ['read'],
          expiresInSeconds: 600,
        }),
      ],
      agent,
    );
    expect(handed.code, handed.stdout).toBe(0);
    const answer = detailOf(handed);
    const childFile = `delegation.child-${String(answer['childDelegationId'])}`;
    // Compared as a flag, so a failure never prints what was answered.
    const named = answer['credential'] === `(saved to ${join(scratch, childFile)})`;
    expect(named, 'the printed answer names the saved file in place of the credential').toBe(true);
    const childCredential = read(childFile);
    expect(childCredential).not.toBe('');
    expect(handed.stdout.includes(childCredential), 'stdout carries the credential').toBe(false);
    expect(handed.stderr.includes(childCredential), 'stderr carries the credential').toBe(false);
    expect(statSync(join(scratch, childFile)).mode & 0o777).toBe(0o600);
    // The parent's own credential is where its pickup left it.
    expect(read('delegation') === parentCredential, 'the parent credential is unchanged').toBe(
      true,
    );

    const back = await runCli(['run.child_handback', '--json', '{"outcome":"completed"}'], {
      ...agent,
      OPS_ASTRO_DELEGATION: childCredential,
    });
    expect(back.code, back.stdout).toBe(0);
    expect(back.stdout.includes(childCredential), 'stdout carries the credential').toBe(false);
  }, 180_000);
});
