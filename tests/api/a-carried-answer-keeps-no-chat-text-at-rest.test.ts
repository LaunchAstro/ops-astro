// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried answer's words travel only in transit: on the call's line, as
// WebSocket broadcasts, which Realtime stores nowhere. At rest there is only
// the kept reply. The database's own broadcasts, which Realtime does store
// (`realtime.messages`), are the doorbell's rings, ids only, on the agent's
// topic; no call topic is ever stored. The carriers row holds ids and times,
// and no operation result or audit event holds the question or the answer.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QUESTION = 'question-words-3f71 what is due?';
const ANSWER = 'answer-words-8c20';

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried answer at rest', () => {
  let world: CarriedWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_at_rest');
    world.ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, [ANSWER, ' ok']),
    });
  }, 180_000);

  afterAll(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it('stores only id-only doorbells, and no word of it anywhere but the reply', async () => {
    const events = await (await ask(world, QUESTION)).rest();
    expect(events.some((event) => event.event === 'piece')).toBe(true);
    expect(await repliesTo(world, QUESTION)).toBe(1);
    const { admin } = world.w.fixture.db;
    const stored = await admin.execute<{ readonly topic: string; readonly payload: unknown }>(
      `select topic, payload from realtime.messages order by inserted_at`,
    );
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) {
      expect(row.topic).toMatch(/^carry:[0-9a-f-]{36}:agent:[0-9a-f-]{36}$/u);
      expect(Object.keys(row.payload as object).toSorted()).toStrictEqual(['c', 'k']);
    }
    const atRest = await admin.execute<{ readonly text: string }>(
      `select row_to_json(k)::text as text from public.model_call_carriers k
       union all select coalesce(result::text, '') from public.operations
       union all select row_to_json(a)::text from public.audit_events a
       union all select row_to_json(m)::text from realtime.messages m`,
    );
    const all = atRest.map((row) => row.text).join('\n');
    expect(all).not.toContain('question-words-3f71');
    expect(all).not.toContain(ANSWER);
  }, 60_000);

  it('a call topic sent from the database would be stored, so the check can see one', async () => {
    const { admin } = world.w.fixture.db;
    const topic = `carry:${world.w.fixture.business}:call:${crypto.randomUUID()}`;
    await admin.execute(`select realtime.send($1::jsonb, 'request', $2, true)`, [
      JSON.stringify({ words: ANSWER }),
      topic,
    ]);
    const found = await admin.execute(`select 1 from realtime.messages where topic = $1`, [topic]);
    expect(found).toHaveLength(1);
  });
});
