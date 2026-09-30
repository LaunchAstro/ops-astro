// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the plan accept is the only activation. One person's approval of the
// plan's gate pins the entry file and captures the accept-time manifest in the
// same transaction, and every AW-02 case that needs an activated run runs here
// on a run this accept activated (moved from AW-02, TR-S-PIR2A-1).

import { randomUUID } from 'node:crypto';
import { describe, expect, it as vitestIt } from 'vitest';
import {
  acceptPlan,
  captureManifest,
  identityOf,
  setDigest,
  type ReadAuditNote,
  type ReadRequest,
} from '../../packages/core-runtime/src/index.ts';
import { enrol } from '../commands/fixture.ts';
import {
  encode,
  ENTRY,
  FILES,
  fingerprint,
  FRAGMENT,
  leaseOf,
  readAs,
  sourceOf,
} from './aw-02-world.ts';
import {
  acceptAs,
  acceptRequest,
  gateOf,
  noDatabase,
  pinsOf,
  proposed,
  useAw04World,
  w,
} from './aw-04-world.ts';
import { asAgent, pickup, racer, type Schedules } from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw04_accept');

/** Accepted and picked up: the run's id and the worker's read request for `path`. */
async function acceptedAndPicked(
  owner: Schedules,
  title: string,
): Promise<{ readonly runId: string; readonly read: (path: string) => ReadRequest }> {
  const plan = await proposed(owner, title);
  const accepted = await acceptAs(owner, acceptRequest(owner, plan));
  if (!accepted.ok) throw new Error(`accept refused ${accepted.refusal.code}`);
  const picked = await pickup(owner, accepted.value.reservationId);
  const lease = await leaseOf(owner, picked['leaseId']);
  return {
    runId: lease.run_id,
    read: (path) => ({
      leaseId: String(picked['leaseId']),
      holderActorId: lease.holder_actor_id,
      runId: lease.run_id,
      stepId: null,
      path,
    }),
  };
}

async function ledgerOf(
  owner: Schedules,
  runId: string,
): Promise<readonly { sequence: number; path: string; is_entry: boolean }[]> {
  return await owner.db.admin.execute(
    `select sequence, path, is_entry from public.bootstrap_reads
      where run_id = $1 order by sequence`,
    [runId],
  );
}

it('plan_accept_activates_pinned_file: the approval pins the entry file on its own run, in one transaction', async () => {
  const plan = await proposed(w.alpha, 'aw04 activates');
  const accepted = await acceptAs(w.alpha, acceptRequest(w.alpha, plan));
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.value.decision).toBe('approve');
  expect(accepted.value.runId).toBe(plan.proposal['runId']);
  const entry = identityOf(ENTRY, FILES.get(ENTRY) ?? new Uint8Array());
  expect(accepted.value.pin).toEqual(entry);
  const pins = await pinsOf(w.alpha, plan.proposal['runId']);
  expect(pins).toHaveLength(1);
  expect(pins[0]).toMatchObject({
    ref_kind: 'bootstrap_file',
    path: ENTRY,
    content_digest: entry.digest,
    content_size: String(entry.size),
    pinned_by_actor_id: w.alpha.decider.actorId,
  });
  expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
    state: 'approved',
    decisions: '1',
  });
});

it('accept_time_manifest: every file the run may read is captured at the accept, by path, digest and size', async () => {
  const plan = await proposed(w.alpha, 'aw04 manifest');
  const files = new Map(FILES);
  const source = sourceOf(files);
  const accepted = await acceptAs(w.alpha, acceptRequest(w.alpha, plan), source);
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  if (!accepted.ok) return;
  expect([...source.asked].toSorted()).toEqual([ENTRY, FRAGMENT].toSorted());
  const expected = await captureManifest(sourceOf(FILES), [ENTRY, FRAGMENT]);
  if (!expected.ok) throw new Error('manifest refused');
  const [pin] = await pinsOf(w.alpha, accepted.value.runId);
  expect(pin?.manifest).toEqual(expected.value.entries);
  expect(pin?.manifest_digest).toBe(expected.value.digest);
  expect(accepted.value.manifestDigest).toBe(expected.value.digest);
  // A change after the accept is a new file; the pin keeps the accepted bytes.
  files.set(FRAGMENT, encode('Changed words.\n'));
  const [after] = await pinsOf(w.alpha, accepted.value.runId);
  expect(after?.manifest_digest).toBe(expected.value.digest);
});

it('pinned_read_refuses_a_moved_file: an entry file changed after the accept is refused, and nothing is recorded', async () => {
  const { runId, read } = await acceptedAndPicked(w.alpha, 'aw04 moved');
  const moved = new Map([...FILES, [ENTRY, encode('# Brief\nWrite something else.\n')]]);
  const notes: ReadAuditNote[] = [];
  const answer = await readAs(w.alpha, read(ENTRY), notes, sourceOf(moved));
  expect(answer).toContain('DEFINITION_DIGEST_MISMATCH');
  expect(notes).toEqual([]);
  expect(await ledgerOf(w.alpha, runId)).toEqual([]);
});

it('AW-04 pin and ledger recorded: the read writes its own ledger row, non-entry reads included, and new bytes at an old path are a new file', async () => {
  const { runId, read } = await acceptedAndPicked(w.alpha, 'aw04 ledger');
  const notes: ReadAuditNote[] = [];
  expect(await readAs(w.alpha, read(ENTRY), notes)).toBe('read');
  expect(await readAs(w.alpha, read(FRAGMENT), notes)).toBe('read');
  expect(await ledgerOf(w.alpha, runId)).toEqual([
    { sequence: 1, path: ENTRY, is_entry: true },
    { sequence: 2, path: FRAGMENT, is_entry: false },
  ]);
  const identities = [ENTRY, FRAGMENT].map((path) =>
    identityOf(path, FILES.get(path) ?? new Uint8Array()),
  );
  expect(notes.map(({ path, digest, size }) => ({ path, digest, size }))).toEqual(identities);
  expect(setDigest(identities).count).toBe(2);
  const [pin] = await pinsOf(w.alpha, runId);
  expect(identityOf(ENTRY, encode('# Brief\nNew bytes.\n')).digest).not.toBe(pin?.content_digest);
});

describe('AW-04 unreadable file', () => {
  it('at the accept: DEFINITION_UNAVAILABLE, and no decision, reservation or pin is written', async () => {
    const plan = await proposed(w.alpha, 'aw04 unreadable at accept');
    const missing = new Map(FILES);
    missing.delete(FRAGMENT);
    const before = await fingerprint(w.alpha);
    const accepted = await acceptAs(w.alpha, acceptRequest(w.alpha, plan), sourceOf(missing));
    expect(accepted.ok).toBe(false);
    if (accepted.ok) return;
    expect(accepted.refusal.code).toBe('DEFINITION_UNAVAILABLE');
    expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
      state: 'pending',
      decisions: '0',
    });
    expect(await fingerprint(w.alpha)).toBe(before);
  });

  it('at the read: a file gone since the accept is DEFINITION_UNAVAILABLE, and nothing is recorded', async () => {
    const { runId, read } = await acceptedAndPicked(w.alpha, 'aw04 unreadable at read');
    const missing = new Map(FILES);
    missing.delete(FRAGMENT);
    const answer = await readAs(w.alpha, read(FRAGMENT), [], sourceOf(missing));
    expect(answer).toContain('DEFINITION_UNAVAILABLE');
    expect(await ledgerOf(w.alpha, runId)).toEqual([]);
  });
});

it("AW-04 manifest divergence: a non-entry read whose bytes are not the manifest's refuses like an entry mismatch", async () => {
  const { runId, read } = await acceptedAndPicked(w.alpha, 'aw04 divergence');
  const diverged = new Map([...FILES, [FRAGMENT, encode('Other words.\n')]]);
  const answer = await readAs(w.alpha, read(FRAGMENT), [], sourceOf(diverged));
  expect(answer).toContain('DEFINITION_DIGEST_MISMATCH');
  expect(await ledgerOf(w.alpha, runId)).toEqual([]);
});

describe('AW-04 authority', () => {
  it('a person without decide on the task is refused, and nothing is pinned', async () => {
    const plan = await proposed(w.alpha, 'aw04 no decide');
    const bystander = await enrol(
      w.alpha.db.app,
      w.alpha.business,
      `aw04-bystander-${randomUUID()}`,
    );
    const accepted = await acceptAs(w.alpha, acceptRequest(w.alpha, plan, bystander));
    expect(accepted.ok).toBe(false);
    if (accepted.ok) return;
    expect(accepted.refusal.code).toBe('SCOPE_NOT_GRANTED');
    expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
    expect((await gateOf(w.alpha, plan.proposal['gateId'])).state).toBe('pending');
  });

  it('an agent can never accept: the decision is refused on its own ground and nothing is pinned', async () => {
    const plan = await proposed(w.alpha, 'aw04 agent accept');
    const answer = await asAgent(w.alpha, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: plan.proposal['gateId'],
      versionId: plan.proposal['versionId'],
      decision: 'approve',
      note: 'agent tries',
    });
    expect(JSON.stringify(answer)).toMatch(/DELEGATION_[A-Z_]+|SCOPE_NOT_GRANTED/u);
    expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
    expect((await gateOf(w.alpha, plan.proposal['gateId'])).state).toBe('pending');
  });

  it('an odd entry path is refused before anything is written', async () => {
    const plan = await proposed(w.alpha, 'aw04 odd path');
    const before = await fingerprint(w.alpha);
    for (const entryPath of ['../SKILL.md', '/etc/passwd', 'skills/./x.md', '']) {
      // eslint-disable-next-line no-await-in-loop
      const accepted = await acceptAs(w.alpha, { ...acceptRequest(w.alpha, plan), entryPath });
      expect(accepted.ok, entryPath).toBe(false);
      if (!accepted.ok) expect(accepted.refusal.code, entryPath).toBe('DEFINITION_UNAVAILABLE');
    }
    expect(await fingerprint(w.alpha)).toBe(before);
    expect((await gateOf(w.alpha, plan.proposal['gateId'])).state).toBe('pending');
  });
});

describe('AW-04 accept once', () => {
  it('a second accept of the same gate is refused and leaves one decision and one pin', async () => {
    const plan = await proposed(w.alpha, 'aw04 twice');
    const first = await acceptAs(w.alpha, acceptRequest(w.alpha, plan));
    expect(first.ok).toBe(true);
    const second = await acceptAs(w.alpha, acceptRequest(w.alpha, plan));
    expect(second.ok).toBe(false);
    expect(await pinsOf(w.alpha, plan.proposal['runId'])).toHaveLength(1);
    expect((await gateOf(w.alpha, plan.proposal['gateId'])).decisions).toBe('1');
  });
});

describe('AW-04 accept once, raced and rolled back', () => {
  it('two accepts of one gate at once: one approval, one pin, the other refused', async () => {
    const [left, right] = [racer(w.alpha), racer(w.alpha)];
    for (let round = 0; round < 5; round += 1) {
      // Sequential: each round is its own race.
      // eslint-disable-next-line no-await-in-loop
      const plan = await proposed(w.alpha, `aw04 race ${String(round)}`);
      const request = acceptRequest(w.alpha, plan);
      // eslint-disable-next-line no-await-in-loop
      const answers = await Promise.all([
        acceptAs(w.alpha, request, sourceOf(FILES), left),
        acceptAs(w.alpha, request, sourceOf(FILES), right),
      ]);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      // eslint-disable-next-line no-await-in-loop
      expect(await pinsOf(w.alpha, plan.proposal['runId'])).toHaveLength(1);
      // eslint-disable-next-line no-await-in-loop
      expect((await gateOf(w.alpha, plan.proposal['gateId'])).decisions).toBe('1');
    }
    await Promise.all([left.close(), right.close()]);
  });

  it('a rolled-back accept commits nothing, and a second click is a new decision', async () => {
    const plan = await proposed(w.alpha, 'aw04 rolled back');
    const request = acceptRequest(w.alpha, plan);
    await expect(
      w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
        const accepted = await acceptPlan(tx, request, sourceOf(FILES));
        expect(accepted.ok).toBe(true);
        throw new Error('the response was lost');
      }),
    ).rejects.toThrow('the response was lost');
    expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
    expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
      state: 'pending',
      decisions: '0',
    });
    const again = await acceptAs(w.alpha, request);
    expect(again.ok).toBe(true);
    expect(await pinsOf(w.alpha, plan.proposal['runId'])).toHaveLength(1);
  });
});
