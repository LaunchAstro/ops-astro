// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one isolation case: three crossings on one world */
//
// `WF-6 isolation` (roadmap #639, standing gate 9): charting never reads,
// lists, counts or cites across a business, a client or a delegation. Three
// crossings, statuses checked, with canaries planted on the foreign side that
// never appear in any answer, refusals included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';
import type { PreAnswerView } from './wf-6.test.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();

const ticketsOf = (answer: unknown) =>
  (answer as { detail: { tickets: Record<string, string> } }).detail.tickets;

describe.skipIf(serverUrl === undefined)('WF-6 isolation', () => {
  let w: WayfinderWorld;
  let owner: Decider;

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  beforeAll(async () => {
    w = await wayfinderWorld('wf6iso', 'wfsixiso');
    owner = await w.decider('owner');
    await w.grant(owner, 'assign');
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('WF-6 isolation', async () => {
    // Map B, for another client, holds a recorded decision with canaries.
    const b = await w.as(owner, {
      command: 'map.chart',
      title: 'canary-map-B',
      tickets: [{ ref: 'b', title: 'canary-decision-B', type: 'research' }],
    });
    const mapB = must(b, 'chart B').id;
    const decisionB = ticketsOf(b)['b'] as string;
    must(await w.as(owner, { command: 'task.claim', ...(await at(decisionB)) }), 'claim');
    must(
      await w.as(owner, {
        command: 'task.resolve',
        ...(await at(decisionB)),
        answer: 'canary-answer-B',
        gist: 'canary-gist-B',
      }),
      'resolve',
    );
    // Map A, for one client, cites B's decision (its owner may read both).
    const a = await w.as(owner, {
      command: 'map.chart',
      title: 'map A',
      preAnswers: [{ question: 'settled?', answer: 'yes', source: { recordId: decisionB } }],
    });
    const mapA = must(a, 'chart A').id;
    for (const map of [mapA, mapB]) {
      must(
        await w.as(owner, { command: 'map.scope', ...(await at(map)), client: randomUUID() }),
        'scope',
      );
    }
    const foreign = [mapB, decisionB, 'canary-map-B', 'canary-decision-B', 'canary-gist-B'];
    const clean = (answer: unknown) => {
      const text = JSON.stringify(answer);
      for (const canary of foreign) expect(text).not.toContain(canary);
    };
    const cite = [{ question: 'q', answer: 'a', source: { recordId: decisionB } }];

    // 1. Another business: charting there cannot cite this business's decision.
    const bea = await w.outsider('bea');
    const fromBravo = await w.as(
      bea,
      { command: 'map.chart', title: 'x', preAnswers: cite },
      w.bravo,
    );
    expect(codeOf(fromBravo)).toBe('NOT_FOUND');
    clean(fromBravo);
    const readBravo = await w.read(bea, { read: 'map.view', recordId: mapA }, w.bravo);
    expect(codeOf(readBravo)).toBe('NOT_FOUND');

    // 2. Another client in the same business. A person granted only map A
    // sees A's pre-answer with its source withheld, never B's id or title,
    // and cannot read map B.
    const onA = await w.member('on-a', ['read', 'write'], { kind: 'record', id: mapA });
    const seen = (await w.read(onA, { read: 'map.view', recordId: mapA })) as {
      map: { preAnswers: readonly PreAnswerView[] };
    };
    expect(seen.map.preAnswers.map((p) => p.source)).toStrictEqual([{ withheld: true }]);
    clean(seen);
    const readB = await w.read(onA, { read: 'map.view', recordId: mapB });
    expect(codeOf(readB)).toBe('SCOPE_NOT_GRANTED');
    clean(readB);
    // A charter who may write but not read B cannot cite B: it answers as a
    // record that does not exist.
    const writeOnly = await w.member('write-only', ['write']);
    const cited = await w.as(writeOnly, { command: 'map.chart', title: 'x', preAnswers: cite });
    expect(codeOf(cited)).toBe('NOT_FOUND');
    clean(cited);

    // 3. An agent under a live delegation charts nothing citing B and reads
    // neither map (agent reach leans on SL09 U18's credential).
    const picked = await w.pickUp(owner, 'delegated charting');
    const agentChart = await w.asAgent(
      { command: 'map.chart', operationId: randomUUID(), title: 'x', preAnswers: cite },
      picked.credential,
    );
    expect(codeOf(agentChart)).not.toBe('applied');
    clean(agentChart);
    const counted = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.map_components
        where business_id = $1 and kind = 'pre_answer' and source_record_id = $2`,
      [w.business, decisionB],
    );
    expect(counted[0]?.n).toBe('1');
  });
});
