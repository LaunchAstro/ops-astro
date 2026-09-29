// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6: the time entry store, against a real database (CS-4.1, CS-4.28 to
// CS-4.31). A person has one running timer: the database holds it with a
// partial unique index, so two starts at once leave one running entry and the
// other is told so. Stopping logs whole minutes, rounded up, never fewer than
// one, so elapsed time is never dropped. A new entry takes its task's Ad hoc
// mark. Notes and deletes reach only the person's own entries, and a running
// entry is stopped before it can be deleted. The commands over this store
// come next (MP-4-6's command step).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  deleteTimeEntry,
  logTime,
  parseDuration,
  readTaskTime,
  setTimeEntryNote,
  startTimer,
  stopTimer,
} from '../../packages/core-records/src/index.ts';
import type { BusinessId, TenantQuery } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('time-entries: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let db: FreshDatabase | undefined;
let alpha: BusinessId;
let bravo: BusinessId;
let ada: Member;
let noah: Member;
let bravoOwner: Member;
const tasks: Record<string, string> = {};

const seeded = (): FreshDatabase => {
  if (db === undefined) throw new Error('the time database was not seeded');
  return db;
};

const inAlpha = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await seeded().app.withBusiness(alpha, work);

const who = (member: Member) => ({ personId: member.personId, actorId: member.actorId });

const make = async (business: BusinessId, by: Member, name: string, adHoc = false) => {
  const made = await executeCommand(seeded().app, business, by.presented, 'api', {
    operationId: randomUUID(),
    command: 'task.create',
    fields: { title: name },
  } as never);
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  const id = made.recordId ?? '';
  if (adHoc) {
    await seeded().admin.execute(
      `update public.records set data = data || '{"ad_hoc": true}'::jsonb where id = $1`,
      [id],
    );
  }
  tasks[name] = id;
  return id;
};

const running = async (member: Member): Promise<number> => {
  const rows = await seeded().admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.time_entries
      where person_id = $1 and ended_at is null and deleted_at is null`,
    [member.personId],
  );
  return Number(rows[0]?.n);
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'te' });
  const d = db;
  alpha = (await insertBusiness(d.app, 'time-alpha')) as BusinessId;
  bravo = (await insertBusiness(d.app, 'time-bravo')) as BusinessId;
  await installSpine(d.app, alpha);
  await installSpine(d.app, bravo);
  ada = await enrol(d.app, alpha, 'ada');
  noah = await enrol(d.app, alpha, 'noah');
  bravoOwner = await enrol(d.app, bravo, 'bravo-owner');
  await d.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'write');
  });
  await d.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoOwner, 'write');
  });
  await make(alpha, ada, 'site');
  await make(alpha, ada, 'retainer', true);
  await make(alpha, ada, 'other');
  await make(bravo, bravoOwner, 'foreign');
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe('MP-4-6 logging parses', () => {
  it('reads "1h 30m", "90m" and "90" as ninety minutes', () => {
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('90m')).toBe(90);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration(' 2h ')).toBe(120);
    expect(parseDuration('1h30m')).toBe(90);
  });

  it('refuses what is not a length of time', () => {
    for (const bad of ['', ' ', '0', '0m', 'h', '1x', '-5', '1.5', '90 minutes', '1h 70', '25h']) {
      expect(parseDuration(bad), bad).toBeUndefined();
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 timer start and stop', () => {
  it('CS-4.28: start makes a running entry; stop logs whole minutes, rounded up', async () => {
    const task = tasks['site'] ?? '';
    const started = await inAlpha(
      async (tx) => await startTimer(tx, { taskId: task, ...who(ada) }),
    );
    expect(started.kind).toBe('started');
    await seeded().admin.execute(
      `update public.time_entries set started_at = now() - interval '61 seconds'
        where person_id = $1 and ended_at is null`,
      [ada.personId],
    );
    const stopped = await inAlpha(async (tx) => await stopTimer(tx, { taskId: task, ...who(ada) }));
    expect(stopped).toMatchObject({ kind: 'stopped', minutes: 2 });
    expect(await running(ada)).toBe(0);
  });

  it('elapsed time is never dropped: a stop within the first minute logs one', async () => {
    const task = tasks['site'] ?? '';
    await inAlpha(async (tx) => await startTimer(tx, { taskId: task, ...who(ada) }));
    const stopped = await inAlpha(async (tx) => await stopTimer(tx, { taskId: task, ...who(ada) }));
    expect(stopped).toMatchObject({ kind: 'stopped', minutes: 1 });
  });

  it('a stop against a task with no timer of this person running stops nothing', async () => {
    const other = tasks['other'] ?? '';
    const answer = await inAlpha(
      async (tx) => await stopTimer(tx, { taskId: other, ...who(noah) }),
    );
    expect(answer).toStrictEqual({ kind: 'none' });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 one running timer per person', () => {
  it('a second start while one runs is told so, and nothing is written', async () => {
    await inAlpha(
      async (tx) => await startTimer(tx, { taskId: tasks['site'] ?? '', ...who(noah) }),
    );
    const second = await inAlpha(
      async (tx) => await startTimer(tx, { taskId: tasks['other'] ?? '', ...who(noah) }),
    );
    expect(second).toStrictEqual({ kind: 'running' });
    expect(await running(noah)).toBe(1);
    await inAlpha(async (tx) => await stopTimer(tx, { taskId: tasks['site'] ?? '', ...who(noah) }));
  });

  it('two starts at once leave exactly one running entry', async () => {
    const both = await Promise.all(
      ['site', 'other'].map(
        async (name) =>
          await inAlpha(
            async (tx) => await startTimer(tx, { taskId: tasks[name] ?? '', ...who(ada) }),
          ),
      ),
    );
    expect(both.map((answer) => answer.kind).toSorted()).toStrictEqual(['running', 'started']);
    expect(await running(ada)).toBe(1);
    for (const name of ['site', 'other']) {
      // eslint-disable-next-line no-await-in-loop -- one stop at a time
      await inAlpha(async (tx) => await stopTimer(tx, { taskId: tasks[name] ?? '', ...who(ada) }));
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 entries inherit Ad hoc', () => {
  it('a new entry, timed or logged, takes its task’s Ad hoc mark', async () => {
    const retainer = tasks['retainer'] ?? '';
    await inAlpha(async (tx) => await startTimer(tx, { taskId: retainer, ...who(noah) }));
    await inAlpha(async (tx) => await stopTimer(tx, { taskId: retainer, ...who(noah) }));
    await inAlpha(
      async (tx) => await logTime(tx, { taskId: retainer, ...who(noah), minutes: 30, note: '' }),
    );
    const time = await inAlpha(async (tx) => await readTaskTime(tx, retainer, noah.personId));
    expect(time.entries.map((entry) => entry.adHoc)).toStrictEqual([true, true]);
    const plain = await inAlpha(
      async (tx) =>
        await logTime(tx, { taskId: tasks['other'] ?? '', ...who(noah), minutes: 5, note: '' }),
    );
    expect(plain.kind).toBe('logged');
    const other = await inAlpha(
      async (tx) => await readTaskTime(tx, tasks['other'] ?? '', noah.personId),
    );
    expect(other.entries.every((entry) => !entry.adHoc)).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 notes and deletes are the person’s own', () => {
  it('CS-4.29 and CS-4.30: a note edits and an entry deletes, on the person’s own entry only', async () => {
    const task = tasks['other'] ?? '';
    const logged = await inAlpha(
      async (tx) => await logTime(tx, { taskId: task, ...who(ada), minutes: 45, note: 'first' }),
    );
    if (logged.kind !== 'logged') throw new Error('not logged');
    const entryId = logged.entryId;
    expect(
      await inAlpha(async (tx) => await setTimeEntryNote(tx, { entryId, ...who(noah), note: 'x' })),
    ).toBe(false);
    expect(
      await inAlpha(
        async (tx) => await setTimeEntryNote(tx, { entryId, ...who(ada), note: 'edited' }),
      ),
    ).toBe(true);
    expect(await inAlpha(async (tx) => await deleteTimeEntry(tx, { entryId, ...who(noah) }))).toBe(
      'absent',
    );
    const before = await inAlpha(async (tx) => await readTaskTime(tx, task, ada.personId));
    expect(before.entries.find((entry) => entry.id === entryId)?.note).toBe('edited');
    expect(await inAlpha(async (tx) => await deleteTimeEntry(tx, { entryId, ...who(ada) }))).toBe(
      'deleted',
    );
    const after = await inAlpha(async (tx) => await readTaskTime(tx, task, ada.personId));
    expect(after.entries.map((entry) => entry.id)).not.toContain(entryId);
  });

  it('a running entry is stopped before it can be deleted', async () => {
    const task = tasks['site'] ?? '';
    const started = await inAlpha(
      async (tx) => await startTimer(tx, { taskId: task, ...who(ada) }),
    );
    if (started.kind !== 'started') throw new Error('not started');
    expect(
      await inAlpha(
        async (tx) => await deleteTimeEntry(tx, { entryId: started.entryId, ...who(ada) }),
      ),
    ).toBe('running');
    expect(await running(ada)).toBe(1);
    await inAlpha(async (tx) => await stopTimer(tx, { taskId: task, ...who(ada) }));
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 isolation', () => {
  it('another business: its task takes no entry from here, and its entries never read here', async () => {
    const foreign = tasks['foreign'] ?? '';
    const answer = await inAlpha(
      async (tx) => await startTimer(tx, { taskId: foreign, ...who(ada) }),
    );
    expect(answer).toStrictEqual({ kind: 'no-task' });
    await seeded().app.withBusiness(bravo, async (tx) => {
      await logTime(tx, { taskId: foreign, ...who(bravoOwner), minutes: 60, note: 'canary' });
    });
    const here = await inAlpha(async (tx) => await readTaskTime(tx, foreign, ada.personId));
    expect(here.entries).toStrictEqual([]);
    expect(here.totalMinutes).toBe(0);
  });

  it('the read says which running timer is the reader’s own and no one else’s', async () => {
    const task = tasks['other'] ?? '';
    await inAlpha(async (tx) => await startTimer(tx, { taskId: task, ...who(noah) }));
    const forAda = await inAlpha(async (tx) => await readTaskTime(tx, task, ada.personId));
    expect(forAda.running).toBeNull();
    const forNoah = await inAlpha(async (tx) => await readTaskTime(tx, task, noah.personId));
    expect(forNoah.running?.startedAt).toStrictEqual(expect.any(String));
    await inAlpha(async (tx) => await stopTimer(tx, { taskId: task, ...who(noah) }));
  });
});
