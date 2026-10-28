// SPDX-License-Identifier: AGPL-3.0-only
//
// The six Wayfinder verbs (#1648) run as a real CLI process over loopback HTTP:
// each sends its owning command's body in one request, prints the operation's
// answer, and prints a permission refusal in one line naming the key.
/* eslint-disable max-lines-per-function, no-await-in-loop -- sequential process calls share one HTTP fixture */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './cli-process-harness.ts';
import { countTokens } from '../support/token-count.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-000000000002';
const B = '00000000-0000-4000-8000-000000000003';
const CHART = { title: 'Synthetic map', destination: 'Prove the verbs', tickets: [] };
const GRADUATE = { tickets: [{ title: 'Synthetic ticket', type: 'task' }] };
const REVISED = { recordId: ID, expectedRevision: 7 };

describe('S2 six named verbs through a CLI process and HTTP', () => {
  let scratch: string;
  let origin: string;
  let answer: Record<string, unknown>;
  let status = 200;
  const requests: { path: string; method: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? '',
      method: request.method,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  });

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 's2-six-verbs-'));
    writeFileSync(join(scratch, 'chart.json'), JSON.stringify(CHART));
    writeFileSync(join(scratch, 'graduate.json'), JSON.stringify(GRADUATE));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    rmSync(scratch, { recursive: true, force: true });
  });

  const cases = () => [
    {
      verb: 'task block',
      command: 'task.set_blocking',
      key: 'task:write',
      args: ['task', 'block', ID, '--revision', '7', '--blocked-by', `${A},${B}`],
      body: { ...REVISED, blockedBy: [A, B] },
    },
    {
      verb: 'task claim',
      command: 'task.claim',
      key: 'task:assign',
      args: ['task', 'claim', ID, '--revision', '7'],
      body: REVISED,
    },
    {
      verb: 'task resolve',
      command: 'task.resolve',
      key: 'task:write',
      args: [
        'task',
        'resolve',
        ID,
        '--revision',
        '7',
        '--answer',
        'Whole answer\nSecond line',
        '--gist',
        'One gist',
      ],
      body: { ...REVISED, answer: 'Whole answer\nSecond line', gist: 'One gist' },
    },
    {
      verb: 'task close',
      command: 'task.close_out_of_scope',
      key: 'task:decide',
      args: ['task', 'close', ID, '--revision', '7', '--reason', 'Outside this map'],
      body: { ...REVISED, reason: 'Outside this map' },
    },
    {
      verb: 'map chart',
      command: 'map.chart',
      key: 'task:write',
      args: ['map', 'chart', '--body-file', join(scratch, 'chart.json')],
      body: CHART,
    },
    {
      verb: 'map graduate',
      command: 'map.graduate',
      key: 'task:write',
      args: [
        'map',
        'graduate',
        ID,
        '--revision',
        '7',
        '--patch',
        A,
        '--body-file',
        join(scratch, 'graduate.json'),
      ],
      body: { ...GRADUATE, ...REVISED, patchId: A },
    },
  ];

  const env = () => ({
    OPS_ASTRO_API_URL: origin,
    OPS_ASTRO_BUSINESS: 'synthetic',
    OPS_ASTRO_TOKEN: 'synthetic-bearer',
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'absent-token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'absent-delegation'),
  });

  const verbs = [
    'task block',
    'task claim',
    'task resolve',
    'task close',
    'map chart',
    'map graduate',
  ];
  it.each(verbs)(
    '%s sends the owning body, prints the operation answer and makes one HTTP round trip',
    async (verb) => {
      const row = cases().find((one) => one.verb === verb);
      if (row === undefined) throw new Error('missing test case');
      status = 200;
      answer = { ok: true, recordId: ID, revision: 8, detail: { synthetic: 'whole answer' } };
      const operationId = randomUUID();
      for (const agent of [false, true]) {
        requests.length = 0;
        const prefix = agent ? ['--agent'] : [];
        const named = await runCli(
          [...row.args, ...prefix, '--operation', operationId, '--json'],
          env(),
        );
        expect(named.code, named.stderr + named.stdout).toBe(0);
        expect(named.json).toEqual(answer);
        expect(requests).toEqual([
          {
            path: `/api/${agent ? 'a/' : ''}b/synthetic/${row.command.replace('.', '/')}`,
            method: 'POST',
            body: { operationId, ...row.body },
          },
        ]);
        requests.length = 0;
        const operation = await runCli(
          [row.command, ...prefix, '--json', JSON.stringify({ operationId, ...row.body })],
          env(),
        );
        expect(operation.code, operation.stderr).toBe(0);
        expect(named.stdout).toBe(operation.stdout);
        expect(requests).toHaveLength(1);
      }
      const plain = await runCli([...row.args], env());
      expect(plain.code, plain.stderr).toBe(0);
      expect(plain.stdout.trim()).toBe(`ok ${row.command} ${ID} r8`);
    },
  );

  it.each(verbs)(
    '%s prints each reached permission refusal in one line naming its key',
    async (verb) => {
      const row = cases().find((one) => one.verb === verb);
      if (row === undefined) throw new Error('missing test case');
      const keys = row.command === 'task.resolve' ? [row.key, 'task:decide'] : [row.key];
      for (const key of keys) {
        status = 403;
        answer = { refused: true, code: 'SCOPE_NOT_GRANTED', names: [key], fixes: [] };
        requests.length = 0;
        const refused = await runCli(row.args, env());
        expect(refused.code, refused.stderr).toBe(1);
        expect(refused.stdout.trim().split('\n')).toEqual([
          `refused SCOPE_NOT_GRANTED. You need ${key}.`,
        ]);
        expect(requests).toHaveLength(1);
      }
    },
  );

  it('the whole help lists the six verbs under 1,500 fixed-tokenizer tokens and sends nothing', async () => {
    requests.length = 0;
    const help = await runCli(['help'], {});
    expect(help.code, help.stderr).toBe(0);
    for (const row of cases()) expect(help.stdout).toContain(row.verb);
    expect(countTokens(help.stdout)).toBeLessThan(1_500);
    expect(requests).toHaveLength(0);
  });

  it('an empty blocking list clears the whole set in one request', async () => {
    status = 200;
    answer = { ok: true, recordId: ID, revision: 8 };
    requests.length = 0;
    const run = await runCli(['task', 'block', ID, '--revision', '7', '--blocked-by', ''], env());
    expect(run.code, run.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ ...REVISED, blockedBy: [] });
  });

  it('an invalid body file is a usage error before HTTP', async () => {
    writeFileSync(join(scratch, 'bad.json'), '[]');
    requests.length = 0;
    const run = await runCli(['map', 'chart', '--body-file', join(scratch, 'bad.json')], env());
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('the body must be a JSON object');
    expect(requests).toHaveLength(0);
  });
});
