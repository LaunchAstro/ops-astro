// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): the database-fault and
// late-delete retention tests run unchanged, except that every export after
// the destructive delete sends the old span under R's trace id instead of the
// fresh handback. Each committed test must then fail.
import { stripTypeScriptTypes } from 'node:module';
import { expect, it as vitestIt } from 'vitest';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork, type Schedules } from './schedules-harness.ts';
import { age, committedBody } from './aw-13-retention-world.ts';
import {
  cursorOf,
  drain,
  exportFor,
  noDatabase,
  spanIds,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('trret_recovery_tests_old_span');

const CASES = [
  {
    file: './trace-retention-recovers-a-delete-after-a-database-fault.test.ts',
    title: "'Trace retention: a database failure after the delete does not lose the fresh trace'",
    final: 'after the database recovers, durable work must restore the deleted fresh trace',
  },
  {
    file: './trace-retention-recovers-a-delete-that-lands-after-a-timeout.test.ts',
    title:
      "'Trace retention: a delete accepted before a timeout cannot remove the recovered fresh trace'",
    final: 'the fresh event must remain retrievable or be exported again after the accepted delete',
  },
] as const;

async function handedBack(): Promise<readonly string[]> {
  const found = await t.alpha.db.app.withBusiness(
    t.alpha.business,
    async (tx) =>
      await tx.query<{ readonly id: string }>(
        "select id from public.run_events where business_id = $1 and kind = 'handed_back'",
        [tx.businessId],
      ),
  );
  return found.map((row) => row.id);
}

interface Seen {
  readonly rejectedByFinal: boolean;
  readonly otherFailure: string | null;
  readonly freshBeforeDelete: boolean;
  readonly freshAfterDelete: boolean;
  readonly postsAfterDelete: number;
  readonly substituted: number;
}

async function runMutated(file: string, title: string, final: string): Promise<Seen> {
  const from = t.target.methods.length;
  const handedBefore = new Set(await handedBack());
  let oldBody = '';
  let substituted = 0;
  const deletedYet = (): boolean => t.target.methods.indexOf('DELETE', from) >= 0;
  // The first drain of the case exports the run's original span: remember it.
  const rememberingDrain = async (s: Schedules): Promise<void> => {
    const before = t.target.received.length;
    await drain(s);
    if (oldBody === '') {
      const posts = t.target.received.filter(
        (_, i) => i >= before && t.target.methods[i] === 'POST',
      );
      oldBody = posts.at(-1) ?? '';
      expect(spanIds([oldBody]).length).toBeGreaterThan(0);
    }
  };
  // Correct before the destructive delete; afterwards the recovery export
  // delivers the old span (same trace id) in place of whatever is due.
  const losingExport = async (s: Schedules): Promise<unknown> => {
    if (!deletedYet()) return await exportFor(s);
    return await exportOnce(t.alpha.db.app, s.business, TRACE_KEY, async () => {
      substituted += 1;
      return await t.target.deliver(oldBody);
    });
  };
  const invoke = new Function(
    't',
    'TRACE_KEY',
    'expect',
    'asAgent',
    'handbackBody',
    'codeOf',
    'liveWork',
    'derivedId',
    'drain',
    'exportFor',
    'cursorOf',
    'expireOnce',
    'age',
    'TRACE_WINDOW_DAYS',
    `return ${stripTypeScriptTypes(committedBody(file, title))};`,
  );
  const committed: () => Promise<void> = invoke(
    t,
    TRACE_KEY,
    expect,
    asAgent,
    handbackBody,
    codeOf,
    liveWork,
    derivedId,
    rememberingDrain,
    losingExport,
    cursorOf,
    expireOnce,
    age,
    TRACE_WINDOW_DAYS,
  );
  let rejectedByFinal = false;
  let otherFailure: string | null = null;
  try {
    await committed();
  } catch (error) {
    if (error instanceof Error && error.message.includes(final)) rejectedByFinal = true;
    else otherFailure = error instanceof Error ? error.message : String(error);
  }

  const fresh = (await handedBack()).filter((id) => !handedBefore.has(id));
  if (fresh.length !== 1)
    throw new Error(`expected one fresh handback, found ${String(fresh.length)}`);
  const freshSpan = derivedId(TRACE_KEY, ['span', t.alpha.business, fresh[0] ?? ''], 16);
  const deletion = t.target.methods.indexOf('DELETE', from);
  const posts = (keep: (i: number) => boolean): string[] =>
    t.target.received.filter((_, i) => i >= from && keep(i) && t.target.methods[i] === 'POST');
  const after = posts((i) => deletion >= 0 && i > deletion);
  return {
    rejectedByFinal,
    otherFailure,
    freshBeforeDelete: spanIds(posts((i) => deletion < 0 || i < deletion)).includes(freshSpan),
    freshAfterDelete: spanIds(after).includes(freshSpan),
    postsAfterDelete: after.length,
    substituted,
  };
}

it('Trace retention: the recovery tests fail when only an old span restores the trace', async () => {
  const seen: Record<string, Seen> = {};
  for (const c of CASES) {
    // eslint-disable-next-line no-await-in-loop -- the two cases share one world, in turn
    seen[c.file] = await runMutated(c.file, c.title, c.final);
  }
  for (const c of CASES) {
    const s = seen[c.file];
    if (s === undefined) throw new Error('case not run');
    expect(s.otherFailure, `${c.file}: no unrelated failure`).toBeNull();
    expect(s.freshBeforeDelete, `${c.file}: the fresh span left before the delete`).toBe(true);
    expect(
      s.substituted,
      `${c.file}: the recovery export substituted the old span`,
    ).toBeGreaterThan(0);
    expect(s.postsAfterDelete, `${c.file}: something was posted after the delete`).toBeGreaterThan(
      0,
    );
    expect(s.freshAfterDelete, `${c.file}: the fresh span was not sent after the delete`).toBe(
      false,
    );
  }
  expect(
    CASES.map((c) => `${c.file}: ${String(seen[c.file]?.rejectedByFinal)}`),
    'each committed recovery test must fail when the fresh span is lost and only an old span restores the trace id',
  ).toEqual(CASES.map((c) => `${c.file}: true`));
}, 240_000);
