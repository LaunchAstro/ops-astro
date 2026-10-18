// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694: a correction published through the real runner (provider doubles,
// the C18-1 fence) is read back through `live_correction.receipts`. The
// runner keeps no whole page: what it keeps of its two captures is the place
// it checked, as calibrated on the page before the send (the effect
// register) and as read live (the receipt's `live_occurrence`). The receipt
// answers both, with the commit and deployment the provider gave. Revoking
// the reader's task read, or reading as a client holding both grants, reads
// exactly as an id that names nothing.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useRegisterWorld, serverUrl, w, approved, publish } from './c80-register-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { enrol, grantTo, shareWithClient, type Member } from '../commands/fixture.ts';

useRegisterWorld();

const receiptsAs = async (member: Member, correctionId: string) =>
  await executeRead(w.world.db.app, w.world.business, member.presented, {
    read: 'live_correction.receipts',
    correctionId,
  });

const taskOf = async (id: string): Promise<string> => {
  const [row] = await w.world.db.admin.execute<{ task_id: string }>(
    'select task_id from public.live_corrections where id = $1',
    [id],
  );
  if (row === undefined) throw new Error('no correction');
  return row.task_id;
};

describe.skipIf(serverUrl === undefined)('a published correction’s receipts', () => {
  it('show the place before and after, the commit and the deployment', async () => {
    const id = await approved();
    const ports = doubles();
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(ports.seen.captured.length).toBeGreaterThanOrEqual(2);
    const answer = await receiptsAs(w.ava, id);
    expect(answer).toMatchObject({ ok: true, correctionId: id });
    if (!('receipts' in answer)) throw new Error('no receipts');
    const live = answer.receipts.find((receipt) => receipt.outcome === 'live');
    expect(live).toMatchObject({ step: 'publish', commit: 'rev-2', deploymentId: 'dep-2' });
    // The place is the approved word with its context on the page, the decoy line included.
    expect(live?.beforeCapture).toStrictEqual({
      text: 'We are a friendly studio. A friendly decoy line.',
      clipped: false,
    });
    expect(live?.afterCapture).toStrictEqual({
      text: 'We are a welcoming studio. A friendly decoy line.',
      clipped: false,
    });
  });
});

describe.skipIf(serverUrl === undefined)('a correction’s receipts, once read is gone', () => {
  it('a revoked task read reads them, and lists them, as nothing', async () => {
    const id = await approved();
    const person = await enrol(w.world.db.app, w.world.business, 'revoked-reader');
    const taskId = await taskOf(id);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, person, 'write', { kind: 'business', id: null }, false, 'run');
      await grantTo(tx, person, 'read', { kind: 'record', id: taskId });
    });
    expect(await receiptsAs(person, id)).toMatchObject({ ok: true, correctionId: id });
    await w.world.db.admin.execute(
      `update public.grants set revoked_at = clock_timestamp()
        where business_id = $1 and subject_id = $2 and collection = 'task' and action = 'read'`,
      [w.world.business, person.personId],
    );
    expect(await receiptsAs(person, id)).toStrictEqual(await receiptsAs(person, randomUUID()));
    const listed = await executeRead(w.world.db.app, w.world.business, person.presented, {
      read: 'live_correction.list',
    });
    expect(listed).toStrictEqual({ ok: true, corrections: [] });
  });

  it('a client holding run:write and task read reads them as an id that names nothing', async () => {
    const id = await approved();
    const sharer = await w.world.decider('client-sharer');
    const { app } = w.world.db;
    await app.withBusiness(w.world.business, async (tx) => await grantTo(tx, sharer, 'share'));
    const client = await shareWithClient(app, w.world.business, sharer, w.taskA);
    const taskId = await taskOf(id);
    await app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, client, 'write', { kind: 'party', id: w.partyA }, false, 'run');
      await grantTo(tx, client, 'read', { kind: 'record', id: taskId });
    });
    const real = await receiptsAs(client, id);
    expect(real).toMatchObject({ code: 'NOT_FOUND' });
    expect(real).toStrictEqual(await receiptsAs(client, randomUUID()));
  });
});
