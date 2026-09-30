// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's allowlist and its no-agent-read line, without a database. A span's
// every cell is a hex identifier, a whole number or a value from a closed
// list, proved by attempting to write a sentence into each; and no operation
// on any surface, an agent's least of all, returns a trace.

import { expect, it } from 'vitest';
import {
  TRACE_ERRORS,
  TRACE_STAGES,
  TRANSFORM_VERSION,
  derivedId,
  otlp,
  traceSpan,
} from '../../packages/core-runtime/src/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';
import { AGENT_SURFACE } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { READ_CATALOGUE } from '../../packages/core-commands/src/reads/catalogue.ts';

const KEY = Buffer.from('aw13-allowlist-key');
const SENTENCE = 'The client asked us to email jo@example.com about https://client.example/site';

const good = () => ({
  traceId: derivedId(KEY, ['trace', 'b', 'r'], 32),
  spanId: derivedId(KEY, ['span', 'b', 'e'], 16),
  stage: 'claimed',
  transformVersion: TRANSFORM_VERSION,
  startedAtMs: 1_000,
  durationMs: null,
  sequence: 1,
  errorCode: null,
});

it('AW-13 allowlist: a sentence written into any cell of a span is refused, and so is a field outside the list', () => {
  expect(traceSpan(good())).toMatchObject({ stage: 'claimed' });
  for (const field of ['traceId', 'spanId', 'stage', 'errorCode', 'transformVersion'] as const) {
    expect(() => traceSpan({ ...good(), [field]: SENTENCE }), field).toThrow(/refused/u);
  }
  for (const field of ['startedAtMs', 'durationMs', 'sequence'] as const) {
    expect(() => traceSpan({ ...good(), [field]: SENTENCE }), field).toThrow(/refused/u);
    expect(() => traceSpan({ ...good(), [field]: -1 }), field).toThrow(/refused/u);
    expect(() => traceSpan({ ...good(), [field]: 1.5 }), field).toThrow(/refused/u);
  }
  expect(() => traceSpan({ ...good(), note: SENTENCE })).toThrow(/allowlist/u);
  expect(() => traceSpan({ ...good(), url: 'https://client.example' })).toThrow(/allowlist/u);
  // The refusal names the field, never the value.
  try {
    traceSpan({ ...good(), stage: SENTENCE });
  } catch (error) {
    expect(String(error)).not.toContain('client');
  }
  // The closed lists themselves hold no sentence: one lower-case word each.
  for (const value of [...TRACE_STAGES, ...TRACE_ERRORS]) expect(value).toMatch(/^[a-z_]+$/u);
});

it('AW-13 allowlist: the exported body holds the span cells and nothing else', () => {
  const body = JSON.parse(otlp([traceSpan({ ...good(), errorCode: 'worker_lost' })])) as {
    resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
  };
  const [span] = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  expect(Object.keys(span ?? {}).toSorted()).toEqual([
    'attributes',
    'endTimeUnixNano',
    'kind',
    'name',
    'spanId',
    'startTimeUnixNano',
    'traceId',
  ]);
  const attributes = ((span?.['attributes'] ?? []) as { key: string }[]).map((each) => each.key);
  expect(attributes).toEqual(['stage', 'sequence', 'error.code']);
});

it('AW-13 keyed ids: the same event under the same key is the same id, and another key or business is not', () => {
  const one = derivedId(KEY, ['span', 'business-a', 'event-1'], 16);
  expect(derivedId(KEY, ['span', 'business-a', 'event-1'], 16)).toBe(one);
  expect(derivedId(Buffer.from('another key'), ['span', 'business-a', 'event-1'], 16)).not.toBe(
    one,
  );
  expect(derivedId(KEY, ['span', 'business-b', 'event-1'], 16)).not.toBe(one);
  expect(one).toMatch(/^[0-9a-f]{16}$/u);
});

it('AW-13 no agent read: no operation on any surface returns a trace, and the agent reaches none', () => {
  const traceLike = /trace|telemetry|span|export/iu;
  expect(COMMAND_SURFACE.map((row) => row.name).filter((name) => traceLike.test(name))).toEqual([]);
  expect([...AGENT_SURFACE].filter((name) => traceLike.test(name))).toEqual([]);
  expect(Object.keys(READ_CATALOGUE).filter((name) => traceLike.test(name))).toEqual([]);
});
