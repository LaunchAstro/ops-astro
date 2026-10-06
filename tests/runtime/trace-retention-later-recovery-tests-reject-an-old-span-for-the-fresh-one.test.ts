// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, Sol PRV-oa-963-R1.3): the second-queued-delete,
// later-owed-run and other-run recovery tests run unchanged, except that once
// a delete takes the recovered run's trace while it holds the fresh
// handback's span, the target stores that run's captured original span in
// place of each of its spans in every later POST, and answers 200 JSON as
// usual. Other runs' spans are untouched. The trace id comes back, the fresh
// span does not, and each committed test must then fail on its final check.
// Each case has a world of its own.

import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it as vitestIt } from 'vitest';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork, type Schedules } from './schedules-harness.ts';
import { age, batchesOf, committedBody, handbackSpan } from './aw-13-retention-world.ts';
import {
  cursorOf,
  drain,
  exportFor,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

const CASES = [
  {
    file: './trace-retention-keeps-recovering-while-a-second-delete-is-queued.test.ts',
    title:
      "'Trace retention: a second queued delete cannot remove a fresh trace after one confirmation'",
    final: 'the fresh handback must remain retrievable or be exported again after D2 lands',
    recovered: 'trace retention two queued deletes',
  },
  {
    file: './trace-retention-recovery-reaches-a-later-owed-run-past-present-ones.test.ts',
    title: "'Trace retention: recovery reaches a later owed run past a present earlier one'",
    final: 'recovery must read B absent and export its fresh span again despite A staying present',
    recovered: 'trace retention owed page B',
  },
  {
    file: './trace-retention-recovery-for-one-run-keeps-another-confirmed-run-gone.test.ts',
    title:
      "'Trace retention: a rewind for one run does not resurrect another run confirmed expired'",
    final: 'A’s fresh trace is restored',
    recovered: 'trace retention other run A',
  },
] as const;

type OtlpSpan = { readonly traceId: string; readonly spanId: string };
type Otlp = { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };

interface Seen {
  readonly rejectedByFinal: boolean;
  readonly otherFailure: string | null;
  readonly substituted: number;
  readonly traceBack: boolean;
  readonly freshHeld: boolean;
}

async function runMutated(c: (typeof CASES)[number]): Promise<Seen> {
  let runId: string | undefined;
  const recording = async (s: Schedules, title: string, budget: number) => {
    const work = await liveWork(s, title, budget);
    if (title === c.recovered) runId = String(work.picked['runId']);
    return work;
  };
  const traceOf = (): string | undefined =>
    runId === undefined ? undefined : derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
  let original: OtlpSpan | undefined;
  let destroyed = false;
  let substituted = 0;
  // The run's handback is its fresh event: a live work's run has none until the case hands back.
  const freshHeld = async (traceId: string): Promise<boolean> => {
    if (runId === undefined) return false;
    const fresh = await handbackSpan(runId).catch(() => null);
    return fresh !== null && t.target.spans.get(traceId)?.has(fresh) === true;
  };
  t.target.tamper = async (method, body) => {
    const traceId = traceOf();
    if (traceId === undefined) return body;
    if (method === 'DELETE') {
      const ids = (JSON.parse(body) as { traceIds: string[] }).traceIds;
      if (!destroyed && ids.includes(traceId) && (await freshHeld(traceId))) destroyed = true;
      return body;
    }
    if (method !== 'POST') return body;
    const otlp = JSON.parse(body) as Otlp;
    for (const scope of otlp.resourceSpans.flatMap((r) => r.scopeSpans)) {
      for (const [at, span] of scope.spans.entries()) {
        if (span.traceId !== traceId) continue;
        original ??= span;
        if (!destroyed) continue;
        scope.spans[at] = original;
        substituted += 1;
      }
    }
    return destroyed ? JSON.stringify(otlp) : body;
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
    'batchesOf',
    'handbackSpan',
    'TRACE_WINDOW_DAYS',
    `return ${stripTypeScriptTypes(committedBody(c.file, c.title))};`,
  );
  const committed: () => Promise<void> = invoke(
    t,
    TRACE_KEY,
    expect,
    asAgent,
    handbackBody,
    codeOf,
    recording,
    derivedId,
    drain,
    exportFor,
    cursorOf,
    expireOnce,
    age,
    batchesOf,
    handbackSpan,
    TRACE_WINDOW_DAYS,
  );
  let rejectedByFinal = false;
  let otherFailure: string | null = null;
  try {
    await committed();
  } catch (error) {
    if (error instanceof Error && error.message.includes(c.final)) rejectedByFinal = true;
    else otherFailure = error instanceof Error ? error.message : String(error);
  } finally {
    t.target.tamper = undefined;
  }
  const traceId = traceOf() ?? '';
  return {
    rejectedByFinal,
    otherFailure,
    substituted,
    traceBack: t.target.stored.has(traceId),
    freshHeld: await freshHeld(traceId),
  };
}

for (const [n, c] of CASES.entries()) {
  describe(c.file, () => {
    useAw13World(`trret_later_old_span_${String(n)}`);
    it(`Trace retention: ${c.file} fails when only an old span restores the trace`, async () => {
      const s = await runMutated(c);
      expect(s.otherFailure, 'no unrelated failure').toBeNull();
      expect(s.substituted, 'recovery POSTs carried the old span').toBeGreaterThan(0);
      expect(s.traceBack, 'the old span brought the trace id back').toBe(true);
      expect(s.freshHeld, 'the fresh span is not held').toBe(false);
      expect(
        s.rejectedByFinal,
        'the committed recovery test must fail when the fresh span is lost and only an old span restores the trace id',
      ).toBe(true);
    }, 120_000);
  });
}
