// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { expect, it as vitestIt } from 'vitest';
import { parse } from 'yaml';
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

/**
 * Every page of the trace's observations. v2 returns only the core and basic groups unless
 * asked: the measurements live in metadata, and only a returned io group shows content absent.
 */
async function observationsOf(traceId: string): Promise<unknown[]> {
  const observations: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page === 0 || cursor !== null; page += 1) {
    if (page >= 20) throw new Error('observations exceed the bounded page count');
    const query = new URLSearchParams({ traceId, limit: '100', fields: 'core,basic,metadata,io' });
    if (cursor !== null) query.set('cursor', cursor);
    // eslint-disable-next-line no-await-in-loop -- each page names the next
    const answer = await read(`/api/public/v2/observations?${query.toString()}`, true);
    if (!object(answer) || !Array.isArray(answer['data']))
      throw new Error('observations are absent');
    observations.push(...answer['data']);
    const next = object(answer['meta']) ? answer['meta']['cursor'] : undefined;
    if (next !== null && next !== undefined && (typeof next !== 'string' || next === ''))
      throw new Error('observation cursor is malformed');
    cursor = typeof next === 'string' ? next : null;
  }
  return observations;
}

const PINS = parse(
  readFileSync(new URL('../../deploy/m5/langfuse-pins.override.yml', import.meta.url), 'utf8'),
) as { services: Record<string, { image: string }> };
const SERVICES = Object.keys(PINS.services).toSorted();
const containers = SERVICES.map((service) => `langfuse-${service}-1`);

/** One line per container, by a format that names only fields holding no setting's value. */
function inspect(names: readonly string[], format: string): string[] {
  return execFileSync('docker', ['inspect', ...names, '--format', format], {
    encoding: 'utf8',
    timeout: 10_000,
  })
    .trim()
    .split('\n');
}

it('the existing M5 target is healthy at its pinned version', async () => {
  const health = await read('/api/public/health');
  if (!object(health) || health['status'] !== 'OK') throw new Error('target is not healthy');
  expect(
    PINS.services['langfuse-web']?.image.includes(`:${String(health['version'])}@sha256:`),
  ).toBe(true);
  expect(inspect(containers, '{{.Config.Image}}')).toEqual(
    SERVICES.map((service) => PINS.services[service]?.image),
  );
});

it('the existing M5 target listens on loopback only, restarts with Docker and keeps signup and media upload off', () => {
  // A container on the host's network, or sharing another's, publishes no bindings to check.
  const modes = inspect(containers, '{{.HostConfig.NetworkMode}}');
  expect(modes).toHaveLength(containers.length);
  for (const mode of modes) expect(mode !== 'host' && !mode.startsWith('container:')).toBe(true);
  for (const line of inspect(
    containers,
    '{{.HostConfig.RestartPolicy.Name}} {{json .HostConfig.PortBindings}}',
  )) {
    const [restart = '', bindings = 'null'] = line.split(' ');
    expect(['always', 'unless-stopped']).toContain(restart);
    const published = Object.values((JSON.parse(bindings) ?? {}) as Record<string, unknown[]>);
    for (const binding of published.flat())
      expect(object(binding) && binding['HostIp'] === '127.0.0.1').toBe(true);
  }
  // Only these exact entries are printed, so no other setting leaves Docker.
  const wanted = [
    'AUTH_DISABLE_SIGNUP=true',
    'LANGFUSE_MEDIA_UPLOAD_ENABLED=false',
    'TELEMETRY_ENABLED=false',
  ];
  const picked = (name: string): string[] =>
    inspect(
      [name],
      `{{range .Config.Env}}${wanted.map((entry) => `{{if eq . "${entry}"}}{{.}};{{end}}`).join('')}{{end}}`,
    )[0]
      ?.split(';')
      .filter(Boolean)
      .toSorted() ?? [];
  expect(picked('langfuse-langfuse-web-1')).toEqual(wanted);
  expect(picked('langfuse-langfuse-worker-1')).toEqual(wanted.slice(1));
});

it('the M5 replay trace shows timings, outcome and call usage with no content', async () => {
  const traceId = process.env['TRACE_PROOF_TRACE_ID'] ?? '';
  if (!/^[a-f0-9]{32}$/u.test(traceId)) throw new Error('proof trace identifier is malformed');
  const observations = await observationsOf(traceId);
  let terminal = false;
  for (const observation of observations) {
    if (!object(observation)) throw new Error('observation is malformed');
    expect(observation['traceId'] === traceId).toBe(true);
    expect(observation['input'] === null && observation['output'] === null).toBe(true);
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
