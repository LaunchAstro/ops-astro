// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import {
  projectMeasurements,
  traceMeasurements,
} from '../../packages/core-runtime/src/trace-measurements.ts';
import { otlp, traceSpan, TRANSFORM_VERSION } from '../../packages/core-runtime/src/trace-span.ts';

const sentence = 'Synthetic message, page text and tool output must stay local';
const span = () =>
  traceSpan({
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    stage: 'handed_back',
    transformVersion: TRANSFORM_VERSION,
    startedAtMs: 1000,
    durationMs: 500,
    sequence: 2,
    errorCode: null,
  });

it.each(['completed', 'failed', 'partial'])(
  'a terminal event exports its recorded %s outcome and bounded call usage',
  (outcome) => {
    const measurements = projectMeasurements({
      kind: 'handed_back',
      recordedOutcome: outcome,
      modelCalls: 3,
      settledCalls: 2,
    });
    const body = otlp([{ ...span(), measurements }]);
    expect(JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0].attributes).toContainEqual({
      key: 'ops-astro.outcome',
      value: { stringValue: outcome },
    });
    expect(body).toContain('"key":"ops-astro.usage.model_calls","value":{"intValue":"3"}');
    expect(body).toContain('"key":"ops-astro.usage.settled_calls","value":{"intValue":"2"}');
    expect(body).not.toContain('token');
  },
);

it('a drop is recorded as dropped and an unrecognised terminal outcome stays unknown', () => {
  expect(
    projectMeasurements({
      kind: 'dropped',
      recordedOutcome: null,
      modelCalls: 1,
      settledCalls: 0,
    }),
  ).toEqual({ outcome: 'dropped', modelCalls: 1, settledCalls: 0 });
  const measurements = projectMeasurements({
    kind: 'handed_back',
    recordedOutcome: sentence,
    modelCalls: 0,
    settledCalls: 0,
  });
  expect(measurements.outcome).toBe('unknown');
  expect(otlp([{ ...span(), measurements }])).not.toContain(sentence);
  expect(
    projectMeasurements({
      kind: 'handed_back',
      recordedOutcome: 'dropped',
      modelCalls: 0,
      settledCalls: 0,
    }).outcome,
  ).toBe('unknown');
});

it.each(['claimed', 'reactivated', 'delegated'])(
  '%s has no terminal outcome or fabricated usage',
  (kind) => {
    const measurements = projectMeasurements({
      kind,
      recordedOutcome: null,
      modelCalls: null,
      settledCalls: null,
    });
    expect(measurements).toEqual({ outcome: null, modelCalls: null, settledCalls: null });
    const body = otlp([{ ...span(), measurements }]);
    expect(body).not.toContain('ops-astro.outcome');
    expect(body).not.toContain('ops-astro.usage');
  },
);

it('measurements refuse content, unknown fields and invalid counts by field name', () => {
  const good = { outcome: 'completed', modelCalls: 2, settledCalls: 1 };
  for (const field of ['outcome', 'modelCalls', 'settledCalls']) {
    expect(() => traceMeasurements({ ...good, [field]: sentence })).toThrow(/refused/u);
  }
  for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, null]) {
    for (const field of ['modelCalls', 'settledCalls']) {
      expect(() => traceMeasurements({ ...good, [field]: count })).toThrow(/refused/u);
    }
  }
  expect(() => traceMeasurements({ ...good, modelCalls: 0 })).toThrow(/settledCalls/u);
  expect(() => traceMeasurements({ ...good, message: sentence })).toThrow(/allowlist/u);
  expect(() => traceMeasurements({ ...good, outcome: null })).toThrow(/refused/u);
  expect(() => traceMeasurements({ ...good, outcome: sentence })).toThrow(/outcome/u);
});
