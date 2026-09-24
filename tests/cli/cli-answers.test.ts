// SPDX-License-Identifier: AGPL-3.0-only
//
// How the command line classifies an answer, and what it sends (Sol 6
// SURFACE-3 and SURFACE-4).
//
// The real `apps/cli/main.ts` runs as its own process against an HTTP stand-in
// that records every body it is sent and answers by path. No database and no
// API: what is under test is the process's own reading of a status and a body,
// and the body it builds.
//
//  - **A refusal is a body flagged `refused: true`**, as the API writes it and
//    the web client reads it. Exit 1.
//  - **Any other non-2xx is a fault**: a JSON 500 `DECISION_INTEGRITY` carries
//    no refusal flag, and a 503 from a proxy may carry no JSON at all. Exit 4,
//    with the body printed as it came.
//  - **Only a write carries an `operationId`** on the person prefix. The
//    registry's `kind` decides; a read goes out with the body the caller gave
//    and nothing added. The agent prefix's envelope requires one on every call,
//    so an agent read still carries one.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './cli-process-harness.ts';

interface Seen {
  readonly path: string;
  readonly body: unknown;
}

const INTEGRITY = { code: 'DECISION_INTEGRITY', message: 'the decision record does not verify' };
const REFUSAL = {
  refused: true,
  code: 'SCOPE_NOT_GRANTED',
  names: ['task:read'],
  fixes: ['ask an admin'],
};
const OUTAGE = 'Service Unavailable: upstream is restarting';

// eslint-disable-next-line max-lines-per-function -- one stand-in, the calls that share it
describe('the command line reads an answer by its refusal flag and sends ids only on writes', () => {
  const seen: Seen[] = [];
  /** What the stand-in answers a `task.read` with, set by each case. */
  let answer: { status: number; type: string; text: string } = {
    status: 200,
    type: 'application/json',
    text: '{}',
  };
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        const path = request.url ?? '';
        seen.push({ path, body: JSON.parse(raw) as unknown });
        const chosen = path.endsWith('/task/read')
          ? answer
          : { status: 200, type: 'application/json', text: JSON.stringify({ ok: true }) };
        response.writeHead(chosen.status, { 'content-type': chosen.type });
        response.end(chosen.text);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const env = (): Record<string, string> => ({
    OPS_ASTRO_API_URL: origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: 'stand-in-bearer',
    OPS_ASTRO_TOKEN_FILE: '/nonexistent/token',
  });

  const bodySentTo = (suffix: string): unknown =>
    seen.findLast((call) => call.path.endsWith(suffix))?.body;

  it('a flagged 403 refusal exits 1 with the body unchanged', async () => {
    answer = { status: 403, type: 'application/json', text: JSON.stringify(REFUSAL) };
    const run = await runCli(['task.read', '--json', '{"taskKey":"T-1"}'], env());
    expect(run.code).toBe(1);
    expect(run.json).toEqual(REFUSAL);
  });

  it('a JSON 500 decision-integrity fault is not a refusal: exit 4, body unchanged', async () => {
    answer = { status: 500, type: 'application/json', text: JSON.stringify(INTEGRITY) };
    const run = await runCli(['task.read', '--json', '{"taskKey":"T-1"}'], env());
    expect(run.code).toBe(4);
    expect(run.json).toEqual(INTEGRITY);
  });

  it('a non-JSON 503 is a fault too: exit 4, the text printed as it came', async () => {
    answer = { status: 503, type: 'text/plain', text: OUTAGE };
    const run = await runCli(['task.read', '--json', '{"taskKey":"T-1"}'], env());
    expect(run.code).toBe(4);
    expect(run.stdout).toBe(`${OUTAGE}\n`);
  });

  it('a 2xx still exits 0', async () => {
    answer = { status: 200, type: 'application/json', text: JSON.stringify({ ok: true }) };
    const run = await runCli(['task.read', '--json', '{"taskKey":"T-1"}'], env());
    expect(run.code).toBe(0);
  });

  it('person.list and settings.read send {}', async () => {
    expect((await runCli(['person.list'], env())).code).toBe(0);
    expect(bodySentTo('/person/list')).toEqual({});
    expect((await runCli(['settings.read'], env())).code).toBe(0);
    expect(bodySentTo('/settings/read')).toEqual({});
  });

  it('a targeted read sends its declared operand and nothing else', async () => {
    answer = { status: 200, type: 'application/json', text: JSON.stringify({ ok: true }) };
    expect((await runCli(['task.read', '--json', '{"taskKey":"T-1"}'], env())).code).toBe(0);
    expect(bodySentTo('/task/read')).toEqual({ taskKey: 'T-1' });
  });

  it('an agent read carries one, because the agent envelope requires it', async () => {
    expect((await runCli(['task.queue'], env())).code).toBe(0);
    expect(bodySentTo('/b/alpha/task/queue')).toEqual({});
    expect((await runCli(['task.queue', '--agent'], env())).code).toBe(0);
    const sent = bodySentTo('/a/b/alpha/task/queue') as Record<string, unknown>;
    expect(sent['operationId']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('a write carries a fresh operationId, and a caller-supplied one is kept', async () => {
    expect((await runCli(['task.create', '--json', '{"title":"x"}'], env())).code).toBe(0);
    const sent = bodySentTo('/task/create') as Record<string, unknown>;
    expect(sent['title']).toBe('x');
    expect(sent['operationId']).toMatch(/^[0-9a-f-]{36}$/u);

    const own = '11111111-2222-4333-8444-555555555555';
    const body = JSON.stringify({ title: 'x', operationId: own });
    expect((await runCli(['task.create', '--json', body], env())).code).toBe(0);
    expect((bodySentTo('/task/create') as Record<string, unknown>)['operationId']).toBe(own);
  });
});
