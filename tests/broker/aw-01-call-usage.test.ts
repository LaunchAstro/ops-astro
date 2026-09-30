// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01: a settled model call records the model that answered and the units
// the answer says it used (ORCH37, for MP-14-9's in/out split and MP-14-6's
// exact model ids). The answer schema reads them; the priced settle writes
// them in the transaction that settles the money, and nothing else does. A
// model id out of shape makes the whole answer malformed, bounded as any
// hostile answer is. The database holds the shapes past the code.

import { expect, it as vitestIt } from 'vitest';
import { liveWork } from '../runtime/schedules-harness.ts';
import { call, noDatabase, rowsOf, s, useBrokerWorld, world } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw01usage');

const usageOf = async (callId: string | null) => {
  const [row] = await rowsOf(callId);
  return {
    state: row?.['state'],
    actual: row?.['actual_minor'],
    model: row?.['model_id'],
    input: row?.['input_units'],
    output: row?.['output_units'],
  };
};

const callIdOf = (result: Awaited<ReturnType<typeof call>>): string | null =>
  result.ok ? result.callId : ((result as { callId?: string }).callId ?? null);

it('AW-01 call usage: a settled call records the model and the units the answer gave', async () => {
  const work = await liveWork(s, 'usage settled', 2_000);
  world.provider.mode('answer');
  const result = await call(work);
  expect(result).toMatchObject({ ok: true, actualMinor: 100 });
  expect(await usageOf(callIdOf(result))).toStrictEqual({
    state: 'settled',
    actual: '100',
    model: 'replay-1',
    input: '40',
    output: '30',
  });
});

it('AW-01 call usage: an answer that names no model records its units and no model', async () => {
  const work = await liveWork(s, 'usage unnamed', 2_000);
  world.provider.mode('unnamed_model');
  const result = await call(work);
  expect(result).toMatchObject({ ok: true, actualMinor: 100 });
  expect(await usageOf(callIdOf(result))).toStrictEqual({
    state: 'settled',
    actual: '100',
    model: null,
    input: '40',
    output: '30',
  });
});

it('AW-01 call usage: a model id out of shape is a malformed answer, bounded as one', async () => {
  const work = await liveWork(s, 'usage hostile model', 2_000);
  world.provider.mode('bad_model');
  const result = await call(work);
  expect(result).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN', heldMinor: 500 });
  expect(await usageOf(callIdOf(result))).toStrictEqual({
    state: 'liability_unknown',
    actual: null,
    model: null,
    input: null,
    output: null,
  });
});

it('AW-01 call usage: a released or held call records none', async () => {
  const released = await liveWork(s, 'usage released', 2_000);
  world.provider.mode('nothing_happened');
  const nothing = await call(released);
  const held = await liveWork(s, 'usage held', 2_000);
  world.provider.mode('costly');
  const costly = await call(held);
  world.provider.mode('answer');
  const none = { model: null, input: null, output: null };
  expect(await usageOf(callIdOf(nothing))).toMatchObject({ state: 'released', ...none });
  expect(await usageOf(callIdOf(costly))).toMatchObject({ state: 'liability_unknown', ...none });
});

it('AW-01 call usage: the database refuses a model id or units out of shape, past the code', async () => {
  const work = await liveWork(s, 'usage past the code', 2_000);
  world.provider.mode('answer');
  const result = await call(work);
  const id = callIdOf(result);
  const set = async (assignments: string) =>
    await s.db.admin.execute(`update public.model_calls set ${assignments} where id = $1`, [
      id,
    ] as never);
  await expect(set(`input_units = -1`)).rejects.toThrow(/model_calls_units_whole/u);
  await expect(set(`output_units = null`)).rejects.toThrow(/model_calls_units_whole/u);
  await expect(set(`model_id = 'two words'`)).rejects.toThrow(/model_calls_model_id_shape/u);
  await expect(set(`model_id = '${'m'.repeat(129)}'`)).rejects.toThrow(
    /model_calls_model_id_shape/u,
  );
  expect(await usageOf(id)).toMatchObject({ model: 'replay-1', input: '40', output: '30' });
});
