// SPDX-License-Identifier: AGPL-3.0-only
//
// Replaying an old handback leaves the current lease's saved credential alone
// (Sol 6 SURFACE-1 at 9ddfa09).
//
// The delegation file holds the credential the last `task.pickup` saved. A
// successful `task.handback` removes it, because that lease is over. But a
// handback can be answered successfully for a lease that is not the one in the
// file: the agent hands back lease A, picks up lease B, then replays A's
// handback with A's operation id and A's credential from
// `OPS_ASTRO_DELEGATION`. The API answers A's stored success. Removing the
// file then would drop B's credential while B is still live. The file goes
// only when it holds the credential that handback was sent with.
//
// Each call is its own process against the served API, as in
// `cli-process.test.ts`.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
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

// eslint-disable-next-line max-lines-per-function -- one agent, two leases, one replay
describe.skipIf(serverUrl === undefined)('a replayed handback and the saved credential', () => {
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
  const saved = (): string => {
    try {
      return readFileSync(join(scratch, 'delegation'), 'utf8').trim();
    } catch {
      return '';
    }
  };

  /** A task proposed and approved by Ada, so the agent has a reservation to pick up. */
  async function reservation(title: string): Promise<string> {
    const person = env(world.ada.token);
    const created = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title } })],
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
    expect(proposed.code, proposed.stdout).toBe(0);
    const gate = detailOf(proposed);
    const decided = await runCli(
      [
        'task.decide',
        '--json',
        JSON.stringify({
          gateId: gate['gateId'],
          versionId: gate['versionId'],
          decision: 'approve',
          note: 'approved for the replay case',
        }),
      ],
      person,
    );
    expect(decided.code, decided.stdout).toBe(0);
    return String(detailOf(decided)['reservationId']);
  }

  async function pickUp(reservationId: string) {
    const run = await runCli(
      ['task.pickup', '--agent', '--json', JSON.stringify({ reservationId })],
      env(world.agent.token),
    );
    expect(run.code, run.stdout).toBe(0);
    const held = detailOf(run);
    return { credential: saved(), lease: { leaseId: held['leaseId'], fence: held['fence'] } };
  }

  beforeAll(async () => {
    world = await createWorld('clir');
    scratch = mkdtempSync(join(tmpdir(), 'cli-replay-'));
    api = await serveApi(world);
    await world.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [world.alpha],
    );
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it("replaying lease A's handback keeps lease B's credential in the file, and it still works", async () => {
    const first = await reservation('lease A');
    const second = await reservation('lease B');
    const agent = env(world.agent.token, { OPS_ASTRO_AGENT: '1' });

    const a = await pickUp(first);
    expect(a.credential).not.toBe('');
    const handback = {
      operationId: randomUUID(),
      ...a.lease,
      outcome: 'completed',
      report: { wrote: 'a draft' },
    };
    const handedBack = await runCli(['task.handback', '--json', JSON.stringify(handback)], agent);
    expect(handedBack.code, handedBack.stdout).toBe(0);
    // The file held A's credential, and A is over.
    expect(saved()).toBe('');

    const b = await pickUp(second);
    expect(b.credential).not.toBe('');
    expect(b.credential).not.toBe(a.credential);

    const replay = await runCli(['task.handback', '--json', JSON.stringify(handback)], {
      ...agent,
      OPS_ASTRO_DELEGATION: a.credential,
    });
    expect(replay.code, replay.stdout).toBe(0);
    expect(saved()).toBe(b.credential);

    // B's credential still authorises B's calls, read from the file.
    const beat = await runCli(['task.heartbeat', '--json', JSON.stringify(b.lease)], agent);
    expect(beat.code, beat.stdout).toBe(0);
    const done = await runCli(
      [
        'task.handback',
        '--json',
        JSON.stringify({ ...b.lease, outcome: 'completed', report: { wrote: 'b draft' } }),
      ],
      agent,
    );
    expect(done.code, done.stdout).toBe(0);
    // And B's own handback, sent with the file's credential, does remove it.
    expect(saved()).toBe('');
  }, 180_000);
});
