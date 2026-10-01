// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite per ticket: each case is a checklist line on one shared world */
//
// WF-6 (roadmap #639): charting a map. The agent's breadth-first pass
// pre-answers what recorded decisions settle, each with its source, and marks
// the obvious calls "decided, veto open"; `map.chart` files them beside the
// map, its tickets, their blocking and the fog, and resolves nothing.
//
// One test per supporting-checklist line the server carries, the audit
// readback and a refusal per key. `WF-6 isolation` is in wf-6-isolation; the
// sidebar conversation, model egress and the pinned skill are held in
// wf-6-held (each leans on another slice's unmerged unit).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Member,
  type WayfinderWorld,
} from './world.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();

const ticketsOf = (answer: unknown) =>
  (answer as { detail: { tickets: Record<string, string> } }).detail.tickets;
const cite = (recordId: string) => [{ question: 'q', answer: 'a', source: { recordId } }];

export interface PreAnswerView {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly vetoOpen: boolean;
  readonly source:
    | { readonly recordId: string; readonly key: string | null }
    | { readonly reference: string }
    | { readonly withheld: true };
}

interface ChartedView {
  readonly map: {
    readonly preAnswers: readonly PreAnswerView[];
    readonly decisions: readonly unknown[];
    readonly tickets: readonly { readonly id: string; readonly state: string | null }[];
    readonly versions: readonly { readonly changed: readonly string[] }[];
  };
}

describe.skipIf(serverUrl === undefined)('WF-6 charting a map', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let reader: Member;
  let decided: string;

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });
  const chart = async (who: Member, body: Record<string, unknown>) =>
    await w.as(who, { command: 'map.chart', ...body });
  const view = async (who: Member, map: string) =>
    (await w.read(who, { read: 'map.view', recordId: map })) as ChartedView;
  const counts = async () =>
    (
      await w.db.admin.execute<{ readonly records: string; readonly components: string }>(
        `select (select count(*) from public.records)::text as records,
                (select count(*) from public.map_components)::text as components`,
      )
    )[0];

  beforeAll(async () => {
    w = await wayfinderWorld('wf6', 'wfsix');
    owner = await w.decider('owner');
    await w.grant(owner, 'assign');
    reader = await w.member('reader', ['read']);
    // A recorded decision to cite: a research ticket, claimed and resolved.
    const answer = await chart(owner, {
      title: 'earlier map',
      tickets: [{ ref: 'r', title: 'which region hosts it', type: 'research' }],
    });
    decided = ticketsOf(answer)['r'] as string;
    must(await w.as(owner, { command: 'task.claim', ...(await at(decided)) }), 'claim');
    must(
      await w.as(owner, {
        command: 'task.resolve',
        ...(await at(decided)),
        answer: 'Sydney, for the latency',
        gist: 'Sydney region',
      }),
      'resolve',
    );
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('WF-6 every pre-answer cites its source; an uncited pre-answer is refused', async () => {
    const cited = [
      { question: 'Which region?', answer: 'Sydney', source: { recordId: decided } },
      {
        question: 'Key style?',
        answer: 'kebab-case',
        source: { reference: 'docs/current-decisions.md, naming' },
        vetoOpen: true,
      },
    ];
    const map = must(
      await chart(owner, { title: 'cited map', destination: 'a plan', preAnswers: cited }),
      'chart',
    ).id;
    const shown = (await view(owner, map)).map.preAnswers;
    expect(shown.map((p) => [p.question, p.answer, p.vetoOpen, p.source])).toStrictEqual([
      ['Which region?', 'Sydney', false, { recordId: decided, key: expect.any(String) }],
      ['Key style?', 'kebab-case', true, { reference: 'docs/current-decisions.md, naming' }],
    ]);

    const before = await counts();
    for (const uncited of [
      { question: 'q', answer: 'a' },
      { question: 'q', answer: 'a', source: {} },
      { question: 'q', answer: 'a', source: { reference: '   ' } },
      { question: 'q', answer: 'a', source: { reference: 'two\nlines' } },
      { question: 'q', answer: 'a', source: { reference: 'two\r\nlines' } },
      { question: 'q', answer: 'a', source: { reference: 'two\u2028lines' } },
      { question: 'q', answer: 'a', source: { reference: 'two\u2029lines' } },
      { question: 'q', answer: 'a', source: { reference: 'two\u0085lines' } },
      { question: 'q', answer: 'a', source: { reference: 'x', recordId: decided } },
      { question: 'q', answer: 'a', source: { recordId: 'not-an-id' } },
      { question: '', answer: 'a', source: { reference: 'x' } },
      { question: 'q', answer: 'a', source: { reference: 'x' }, vetoOpen: 'yes' },
    ]) {
      const answer = await chart(owner, { title: 'uncited', preAnswers: [cited[0], uncited] });
      expect(codeOf(answer)).toBe('FIELD_VALUE_INVALID');
      expect(JSON.stringify(answer)).toContain('preAnswers');
    }
    expect(await counts()).toStrictEqual(before);
  });

  it('WF-6 a pre-answer cites only a recorded decision the charter can read', async () => {
    const open = await chart(owner, {
      title: 'open map',
      tickets: [{ ref: 'o', title: 'still open', type: 'research' }],
    });
    const openTicket = ticketsOf(open)['o'] as string;
    // No such record, and another business's record, answer alike.
    const bravoTicket = (await w.create(await w.outsider('bea'), { title: 'bravo' }, {}, w.bravo))
      .id;
    const before = await counts();
    // An open ticket is not a recorded decision.
    expect(codeOf(await chart(owner, { title: 'x', preAnswers: cite(openTicket) }))).toBe(
      'FIELD_VALUE_INVALID',
    );
    for (const id of [randomUUID(), bravoTicket]) {
      const answer = await chart(owner, { title: 'x', preAnswers: cite(id) });
      expect(codeOf(answer)).toBe('NOT_FOUND');
      expect(JSON.stringify(answer)).not.toContain(id);
    }
    expect(await counts()).toStrictEqual(before);
  });

  it('WF-6 charting resolves nothing', async () => {
    const decidedRevision = await w.revisionOf(decided);
    const answer = await chart(owner, {
      title: 'nothing resolved',
      destination: 'd',
      tickets: [
        { ref: 'g', title: 'a real choice', type: 'grilling' },
        { ref: 'r', title: 'look it up', type: 'research', blockedBy: ['g'] },
      ],
      preAnswers: [{ question: 'Which region?', answer: 'Sydney', source: { recordId: decided } }],
      fog: ['later'],
    });
    const map = must(answer, 'chart').id;
    const { map: shown } = await view(owner, map);
    expect(shown.decisions).toStrictEqual([]);
    expect(shown.tickets).toHaveLength(2);
    const categories = await w.db.admin.execute<{ readonly category: string }>(
      `select s.data ->> 'machine_category' as category from public.records c
         join public.records s on s.business_id = c.business_id and s.id = c.uuid_1
        where c.business_id = $1 and c.uuid_4 = $2`,
      [w.business, map],
    );
    expect(categories.map((row) => row.category)).not.toContain('completed');
    // The cited decision is untouched by being cited.
    expect(await w.revisionOf(decided)).toBe(decidedRevision);
  });

  it('WF-6 the agent never resolves a grilling ticket it filed', async () => {
    const answer = await chart(owner, {
      title: 'agent chart',
      tickets: [{ ref: 'g', title: 'owner picks', type: 'grilling' }],
    });
    const g = ticketsOf(answer)['g'] as string;
    const picked = await w.pickUp(owner, 'agent charts a small workflow');
    for (const [command, extra] of [
      ['task.resolve', { answer: 'my own answer', gist: 'self-answered' }],
      ['task.set_type', { taskType: 'research' }],
    ] as const) {
      const tried = await w.asAgent(
        { command, operationId: randomUUID(), ...(await at(g)), ...extra },
        picked.credential,
      );
      expect(codeOf(tried)).not.toBe('applied');
    }
    const rows = await w.db.admin.execute<{ readonly type: string; readonly gist: string | null }>(
      `select data->>'type' as type, data->>'gist' as gist from public.records
        where business_id = $1 and id = $2`,
      [w.business, g],
    );
    expect(rows[0]).toStrictEqual({ type: 'grilling', gist: null });
  });

  it('WF-6 each change is recorded by map.chart in its transaction and joins the audit chain', async () => {
    const before = (await w.audit()).length;
    const answer = await chart(owner, {
      title: 'recorded chart',
      tickets: [
        { ref: 'a', title: 'first', type: 'research' },
        { ref: 'b', title: 'second', type: 'task', blockedBy: ['a'] },
      ],
      preAnswers: [
        { question: 'q1', answer: 'a1', source: { recordId: decided } },
        { question: 'q2', answer: 'a2', source: { reference: 'the brief' }, vetoOpen: true },
      ],
    });
    const map = must(answer, 'chart').id;
    const lines = (await w.audit()).slice(before);
    expect(lines.map((l) => [l.command, l.outcome])).toStrictEqual([['map.chart', 'applied']]);
    const rows = await w.db.admin.execute<{
      readonly id: string;
      readonly question: string;
      readonly body: string;
      readonly source_record_id: string | null;
      readonly source_reference: string | null;
      readonly veto_open: boolean;
    }>(
      `select id, question, body, source_record_id, source_reference, veto_open
         from public.map_components
        where business_id = $1 and map_id = $2 and kind = 'pre_answer' order by position`,
      [w.business, map],
    );
    expect(
      rows.map((r) => [r.question, r.body, r.source_record_id, r.source_reference, r.veto_open]),
    ).toStrictEqual([
      ['q1', 'a1', decided, null, false],
      ['q2', 'a2', null, 'the brief', true],
    ]);
    // The chart's one version names every pre-answer it added.
    const { map: shown } = await view(owner, map);
    for (const row of rows) expect(shown.versions[0]?.changed).toContain(row.id);
    const report = await w.db.app.withBusiness(w.business, (tx) => verifyAuditChain(tx));
    expect(report.intact).toBe(true);
  });

  it('WF-6 refuses task:write to a caller without it, and writes nothing', async () => {
    const before = await counts();
    const answer = await chart(reader, {
      title: 'x',
      preAnswers: [{ question: 'q', answer: 'a', source: { reference: 'r' } }],
    });
    expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    expect(await counts()).toStrictEqual(before);
  });
});
