// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1g: the queue-and-delivery conformance proof for the inbox part
// (supporting checklist: "It goes red under authority, count, clearing and
// attempt-state faults, has no skipped database case, and records any case it
// cannot build as a gap").
//
// Each fault is one exact line changed in a disposable copy of the source
// (`tests/support/source-mutant.ts`), and each probe runs the shipped module
// and the mutant's copy of the same module against one real database. A probe
// must hold on the shipped code and fail on its mutant, so a fault the suites
// could not see would fail this file rather than pass it.
//
// - authority: the inbox read lists a withheld item;
// - count: the owed count counts every open item instead of the counted ones;
// - clearing: a decision closes the items of every other gate instead of its own;
// - attempt state: the last delivery reads the first attempt, not the latest.
//
// Gap, recorded: the delivery cases "with a restart" drive the worker and the
// live channel (T2b, T2f), which are not on this base. The read-back after an
// API and a browser restart is `tests/cli/inbox-readback.test.ts`; the worker
// and channel cases join this proof when those parts land.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem, type TenantQuery } from '../../packages/core-records/src/index.ts';
import * as shippedRecords from '../../packages/core-records/src/index.ts';
import type * as ReadsModule from '../../packages/core-commands/src/reads/inbox.ts';
import type * as EnvelopeModule from '../../packages/core-commands/src/commands/envelope.ts';
import type * as ConfigModule from '../../packages/core-runtime/src/runtime-config.ts';
import { createSourceMutant, type MutationSpec } from '../support/source-mutant.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { clearingWorld, ok } from '../commands/inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const READS = 'packages/core-commands/src/reads/inbox.ts';
const RECORDS = 'packages/core-records/src/index.ts';
const ENVELOPE = 'packages/core-commands/src/commands/envelope.ts';
const CONFIG = 'packages/core-runtime/src/runtime-config.ts';

type Reads = typeof ReadsModule;
type Envelope = typeof EnvelopeModule;
type Config = typeof ConfigModule;
type Records = typeof shippedRecords;

const FAULTS = {
  authority: {
    file: READS,
    from: "item.access !== 'withheld'",
    to: 'true',
  },
  count: {
    file: 'packages/core-records/src/inbox/read.ts',
    from: "and i.work_state = 'open' and i.owed and r.deleted_at is null",
    to: "and i.work_state = 'open' and r.deleted_at is null",
  },
  clearing: {
    file: 'packages/core-records/src/inbox/clear.ts',
    from: "and i.fact_id = $2 and i.work_state = 'open'",
    to: "and i.fact_id <> $2 and i.work_state = 'open'",
  },
  attemptState: {
    file: 'packages/core-records/src/inbox/read.ts',
    from: 'order by d.observed_seq desc limit 1',
    to: 'order by d.observed_seq asc limit 1',
  },
} as const satisfies Record<string, MutationSpec>;

/** The shipped module, by the same repository-relative path a mutant loads. */
const shipped = async <T>(entry: string): Promise<T> => (await import(`../../${entry}`)) as T;

/** Shipped holds, mutant fails: the probe loads what it runs from one side only. */
async function proves(
  spec: MutationSpec,
  probe: (load: <T>(entry: string) => Promise<T>) => Promise<boolean>,
): Promise<void> {
  expect(await probe(shipped), 'the probe holds on the shipped code').toBe(true);
  const mutant = createSourceMutant(spec);
  try {
    expect(await probe(async (entry) => await mutant.load(entry)), 'the mutant is caught').toBe(
      false,
    );
  } finally {
    mutant.dispose();
  }
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1g queue-and-delivery conformance proof', () => {
  const w = clearingWorld('i1gc');

  const inAlpha = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await w.fixture.db.app.withBusiness(w.fixture.business, work);
  const task = async (title: string): Promise<string> =>
    String(ok(await w.call('task.create', { fields: { title } })).body['recordId']);
  const raise = async (recipient: string, subject: string, reason: 'mention' | 'run_finished') =>
    await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: recipient,
          subjectRecordId: subject,
          reason,
          fact:
            reason === 'run_finished'
              ? { kind: 'planned_run', id: randomUUID() }
              : { kind: 'record', id: randomUUID() },
        }),
    );

  it('INB-1 conformance, authority: a withheld item listed by the read is caught', async () => {
    const reader: Member = await enrol(w.fixture.db.app, w.fixture.business, 'Proof Reader');
    const readable = await task('proof readable');
    const hidden = await task('proof hidden');
    await inAlpha(async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: reader.personId },
        scope: { kind: 'record', id: readable },
        collection: 'task',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: w.fixture.member.actorId,
      });
      if (!issued.ok) throw new Error(issued.refusal.code);
    });
    await raise(reader.personId, readable, 'mention');
    const withheld = await raise(reader.personId, hidden, 'mention');
    await proves(FAULTS.authority, async (load) => {
      const reads = await load<Reads>(READS);
      return (await inAlpha(async (tx) => await reads.readInbox(tx, reader.personId))).every(
        (entry) => entry.id !== withheld,
      );
    });
  });

  it('INB-1 conformance, count: a count that is not the list’s counted entries is caught', async () => {
    const subject = await task('proof count');
    await raise(w.reviewer.personId, subject, 'mention');
    await raise(w.reviewer.personId, subject, 'run_finished');
    await proves(FAULTS.count, async (load) => {
      const reads = await load<Reads>(READS);
      return await inAlpha(async (tx) => {
        const listed = (await reads.readInbox(tx, w.reviewer.personId)).filter((e) => e.counted);
        return (await reads.countOwed(tx, w.reviewer.personId)) === listed.length;
      });
    });
  });

  it('INB-1 conformance, clearing: a decision that closes another gate’s items is caught', async () => {
    await proves(FAULTS.clearing, async (load) => {
      const envelope = await load<Envelope>(ENVELOPE);
      const config = await load<Config>(CONFIG);
      const decided = await w.proposed(`proof clearing ${randomUUID().slice(0, 8)}`);
      const other = await w.proposed(`proof other ${randomUUID().slice(0, 8)}`);
      const answer = await config.withRuntimeKeys(
        config.runtimeKeys({ ...w.fixture.environment }),
        async () =>
          await envelope.executeCommand(
            w.fixture.db.app,
            w.fixture.business,
            w.reviewer.presented,
            'api',
            {
              command: 'task.decide',
              operationId: randomUUID(),
              gateId: decided.gateId,
              versionId: decided.versionId,
              decision: 'approve',
              note: 'proof',
            },
          ),
      );
      if ('refused' in answer) throw new Error(`decide refused: ${answer.code}`);
      const own = await w.itemsOnFact(decided.gateId);
      const others = await w.itemsOnFact(other.gateId);
      return (
        own.every((i) => i.work_state === 'cleared') && others.every((i) => i.work_state === 'open')
      );
    });
  });

  it('INB-1 conformance, attempt state: a last delivery read off the first attempt is caught', async () => {
    const subject = await task('proof attempts');
    const item = await raise(w.reviewer.personId, subject, 'mention');
    await inAlpha(async (tx) => {
      await shippedRecords.recordDeliveryAttempt(tx, {
        itemId: item,
        channel: 'in_app',
        state: 'asked',
      });
      await shippedRecords.recordDeliveryAttempt(tx, {
        itemId: item,
        channel: 'in_app',
        state: 'delivered',
      });
    });
    await proves(FAULTS.attemptState, async (load) => {
      const records = await load<Records>(RECORDS);
      return await inAlpha(async (tx) => {
        const read = (await records.readInboxItems(tx, w.reviewer.personId)).find(
          (i) => i.id === item,
        );
        return read?.lastDelivery === 'delivered';
      });
    });
  });
});
