// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04 pin recovery, through the production accept command against a real
// database and a real instruction root on disk. The store the files are read
// from unavailable at the click is our fault, not the plan's: the person is
// told so in plain words, nothing is approved and no run starts. A restore
// that puts different bytes at a path is a new file: runs pinned before keep
// the old digest, a read on one of them refuses the new bytes, and the next
// accept pins the new digest.

import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it as vitestIt } from 'vitest';
import {
  directorySource,
  INSTRUCTION_ROOT_VARIABLE,
  type ReadRequest,
} from '../../packages/core-runtime/src/index.ts';
import { ENTRY, encode, FILES, fingerprint, leaseOf, readAs } from './aw-02-world.ts';
import {
  acceptBody,
  gateOf,
  noDatabase,
  pinsOf,
  planRecordsOf,
  proposed,
  useAw04World,
  useInstructionRoot,
  w,
  type Proposed,
} from './aw-04-world.ts';
import { appliedDetail, asPerson, codeOf, pickup, rows } from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw04_pin');
useInstructionRoot();

const root = (): string => {
  const at = process.env[INSTRUCTION_ROOT_VARIABLE];
  if (at === undefined) throw new Error('no instruction root');
  return at;
};

async function runStateOf(plan: Proposed): Promise<string | undefined> {
  const found = await rows<{ state: string }>(
    w.alpha,
    'select state from public.planned_runs where business_id = $1 and id = $2',
    [w.alpha.business, plan.proposal['runId']],
  );
  return found[0]?.state;
}

it('AW-04 pin recovery: the instruction store unavailable at the accept: DEFINITION_UNAVAILABLE, fault ours, the person told, nothing approved and no run started', async () => {
  const plan = await proposed(w.alpha, 'aw04 store down');
  const before = await fingerprint(w.alpha);
  const state = await runStateOf(plan);
  const away = `${root()}-away-${randomUUID()}`;
  renameSync(root(), away);
  let answer: Awaited<ReturnType<typeof asPerson>>;
  try {
    answer = await asPerson(w.alpha, acceptBody(plan));
  } finally {
    renameSync(away, root());
  }
  expect(answer).toMatchObject({ code: 'DEFINITION_UNAVAILABLE', names: ['fault: ours'] });
  const told = JSON.stringify(answer);
  expect(told).toMatch(/the fault is ours/iu);
  expect(told).toMatch(/no run started/iu);
  expect(told).not.toContain(root());
  expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
    state: 'pending',
    decisions: '0',
  });
  expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
  expect(await planRecordsOf(w.alpha, plan.proposal['gateId'])).toEqual([]);
  expect(await runStateOf(plan)).toBe(state);
  expect(await fingerprint(w.alpha)).toBe(before);
  // Controls: the store back, the same plan accepts; a file the plan names
  // that the store does not hold is the plan's, not a fault of ours.
  expect(codeOf(await asPerson(w.alpha, acceptBody(plan)))).toBe('applied');
  const other = await proposed(w.alpha, 'aw04 missing path');
  const missing = await asPerson(w.alpha, acceptBody(other, { paths: ['skills/none.md'] }));
  expect(missing).toMatchObject({ code: 'DEFINITION_UNAVAILABLE' });
  expect(JSON.stringify(missing)).not.toMatch(/fault: ours/u);
});

it('AW-04 pin recovery: a restore with new bytes at a path leaves the runs pinned before on the old digest', async () => {
  const first = await proposed(w.alpha, 'aw04 before restore');
  const accepted = appliedDetail(await asPerson(w.alpha, acceptBody(first)), 'first accept');
  const pinnedBefore = await pinsOf(w.alpha, first.proposal['runId']);
  const oldDigest = pinnedBefore[0]?.content_digest;
  const original = FILES.get(ENTRY);
  if (original === undefined || oldDigest === undefined) throw new Error('no entry pinned');

  writeFileSync(join(root(), ENTRY), encode('# Brief\nWrite the brief, restored.\n'));
  try {
    const second = await proposed(w.alpha, 'aw04 after restore');
    const again = appliedDetail(await asPerson(w.alpha, acceptBody(second)), 'second accept');
    const newDigest = (again['pin'] as { digest: string }).digest;
    expect(newDigest).not.toBe(oldDigest);
    expect((await pinsOf(w.alpha, second.proposal['runId']))[0]?.content_digest).toBe(newDigest);
    // The run pinned before keeps its pin, byte for byte.
    expect(await pinsOf(w.alpha, first.proposal['runId'])).toEqual(pinnedBefore);
    // Its worker reading the entry now meets the new bytes and is refused.
    const picked = await pickup(w.alpha, accepted['reservationId']);
    const lease = await leaseOf(w.alpha, picked['leaseId']);
    const read: ReadRequest = {
      leaseId: String(picked['leaseId']),
      holderActorId: lease.holder_actor_id,
      runId: lease.run_id,
      stepId: null,
      path: ENTRY,
    };
    const answer = await readAs(w.alpha, read, [], directorySource(root()));
    expect(answer).toContain('DEFINITION_DIGEST_MISMATCH');
    expect(await pinsOf(w.alpha, first.proposal['runId'])).toEqual(pinnedBefore);
  } finally {
    writeFileSync(join(root(), ENTRY), original);
  }
});
