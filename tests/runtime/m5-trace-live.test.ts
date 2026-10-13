// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { expect, it as vitestIt } from 'vitest';
import { traceExportSettings } from '../../apps/api/trace-exporter.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';

const required = [
  'TRACE_TARGET_ENV_FILE',
  'TRACE_PROOF_TRACE_ID',
  'TRACE_PROOF_OUTCOME',
  'TRACE_PROOF_MODEL_CALLS',
  'TRACE_PROOF_SETTLED_CALLS',
  'TRACE_PROOF_MESSAGE_CANARY',
  'TRACE_PROOF_PAGE_CANARY',
  'TRACE_PROOF_TOOL_CANARY',
];
const it = required.every((name) => Boolean(process.env[name])) ? vitestIt : vitestIt.skip;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function config(): Extract<ReturnType<typeof traceExportSettings>, { kind: 'on' }> {
  const settings = traceExportSettings(
    readEnvFile(process.env['TRACE_TARGET_ENV_FILE'] ?? '', {
      required: true,
    }),
  );
  if (settings.kind !== 'on' || settings.destination.origin !== 'http://127.0.0.1:3400')
    throw new Error('proof requires staged settings for the existing M5 loopback target');
  return settings;
}

/** Operator retrieval only. No exporter, ingestion, deletion or container lifecycle is started. */
function authorization(): string {
  const descriptor = openSync(config().credentialsFile, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536)
      throw new Error('proof credential file must be a bounded owner-only file');
    const entries: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('proof credential file is not a list');
    for (const entry of entries) {
      if (
        object(entry) &&
        entry['ref'] === 'trace_key' &&
        entry['kind'] === 'api_key' &&
        entry['destination'] === 'trace_target' &&
        entry['scheme'] === 'basic' &&
        entry['header'] === 'authorization' &&
        typeof entry['value'] === 'string' &&
        /^pk-lf-[a-zA-Z0-9_-]+:sk-lf-[a-zA-Z0-9_-]+$/u.test(entry['value'])
      )
        return `Basic ${Buffer.from(entry['value']).toString('base64')}`;
    }
    throw new Error('proof project pair is missing');
  } finally {
    closeSync(descriptor);
  }
}

async function read(path: string, authenticated = false): Promise<unknown> {
  try {
    const response = await fetch(`${config().destination.origin}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: authenticated ? { authorization: authorization() } : {},
    });
    if (!response.ok) throw new Error('target read refused');
    if (response.body === null) throw new Error('target read is empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- one bounded read
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) {
        // eslint-disable-next-line no-await-in-loop -- stop this oversized read
        await reader.cancel();
        throw new Error('target read too large');
      }
      chunks.push(next.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new Error('target read did not produce a bounded valid JSON answer');
  }
}

it('the existing M5 target is healthy at its pinned version', async () => {
  const health = await read('/api/public/health');
  if (
    !object(health) ||
    health['status'] !== 'OK' ||
    typeof health['version'] !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(health['version'])
  )
    throw new Error('target is not healthy');
  const images = execFileSync(
    'docker',
    [
      'inspect',
      'langfuse-langfuse-web-1',
      'langfuse-langfuse-worker-1',
      'langfuse-postgres-1',
      'langfuse-redis-1',
      'langfuse-clickhouse-1',
      'langfuse-minio-1',
      '--format',
      '{{.Config.Image}}',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  )
    .trim()
    .split('\n');
  const suffix = `:${health['version']}@sha256:`;
  expect(
    images.length === 6 &&
      images.every((image) => /^[a-f0-9]{64}$/u.test(image.split('@sha256:')[1] ?? '')) &&
      images.slice(0, 2).every((image) => image.includes(suffix)),
  ).toBe(true);
});

it('the M5 replay trace shows timings, outcome and call usage with no content', async () => {
  const traceId = process.env['TRACE_PROOF_TRACE_ID'] ?? '';
  if (!/^[a-f0-9]{32}$/u.test(traceId)) throw new Error('proof trace identifier is malformed');
  const answer = await read(`/api/public/v2/observations?traceId=${traceId}&limit=100`, true);
  if (!object(answer) || !Array.isArray(answer['data'])) throw new Error('observations are absent');
  let terminal = false;
  for (const observation of answer['data']) {
    if (!object(observation)) throw new Error('observation is malformed');
    expect(observation['traceId'] === traceId).toBe(true);
    const input = observation['input'];
    const output = observation['output'];
    expect(
      (input === null || input === undefined) && (output === null || output === undefined),
    ).toBe(true);
    for (const name of [
      'TRACE_PROOF_MESSAGE_CANARY',
      'TRACE_PROOF_PAGE_CANARY',
      'TRACE_PROOF_TOOL_CANARY',
    ])
      expect(JSON.stringify(observation).includes(process.env[name] ?? '')).toBe(false);
    const metadata = observation['metadata'];
    const attributes = object(metadata) ? metadata['attributes'] : undefined;
    if (!object(attributes) || attributes['ops-astro.outcome'] === undefined) continue;
    expect(attributes['ops-astro.outcome'] === process.env['TRACE_PROOF_OUTCOME']).toBe(true);
    expect(
      attributes['ops-astro.usage.model_calls'] === Number(process.env['TRACE_PROOF_MODEL_CALLS']),
    ).toBe(true);
    expect(
      attributes['ops-astro.usage.settled_calls'] ===
        Number(process.env['TRACE_PROOF_SETTLED_CALLS']),
    ).toBe(true);
    const start = observation['startTime'];
    const end = observation['endTime'];
    expect(
      typeof start === 'string' &&
        typeof end === 'string' &&
        Number.isFinite(Date.parse(start)) &&
        Date.parse(end) >= Date.parse(start),
    ).toBe(true);
    terminal = true;
  }
  expect(terminal).toBe(true);
});
