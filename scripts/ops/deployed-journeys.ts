#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// U117 (#1746): the core task journey, run against a deployed version the
// moment the owner deploys it.
//
//   OPS_ASTRO_TOKEN=<bearer> node scripts/ops/deployed-journeys.ts \
//     --origin https://<deployed web origin> --business <key> --out <evidence.json>
//
// The bearer is the made-up admin's, from `ops-astro login` against that
// origin; it is read from the environment, sent only to `--origin`, and never
// printed or written. There is no default origin: the script runs only where
// it is pointed. It names the build `/build.json` carries, then creates a task
// titled with that build, reads it, renames it, reads the new name and trashes
// it, one operation id per write. It stops at the first step that does not
// answer as expected and names it in the server's code. The evidence file
// holds the origin, the build, each step and whether the run passed; the exit
// code is 0 when it passed, 1 when a step failed, 2 for a usage error.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** The build identifier's shape, as `apps/web/build-stamp.ts` writes it. */
const STAMP = /^[0-9a-f]{12}(?:-dirty)?$/u;

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly ms: number;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function usage(message: string): never {
  process.stderr.write(`deployed-journeys: ${message}\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    origin: { type: 'string' },
    business: { type: 'string' },
    out: { type: 'string' },
  },
});
const origin = values.origin ?? usage('name the deployed origin with --origin');
const business = values.business ?? usage('name the business with --business');
const out = values.out ?? usage('name the evidence file with --out');
const bearer = process.env['OPS_ASTRO_TOKEN'] ?? usage('set OPS_ASTRO_TOKEN (ops-astro login)');
/** The origin exactly as URL reads it: a scheme and host, with no path, query, fragment or login. */
function isBareOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === text;
  } catch {
    return false;
  }
}
if (!isBareOrigin(origin)) usage('--origin is a scheme and host only');

/** One request; a redirect is never followed, so the bearer goes nowhere else. */
async function call(path: string, body?: Record<string, unknown>): Promise<Answer> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers:
      body === undefined
        ? {}
        : { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const record = typeof parsed === 'object' && parsed !== null ? parsed : {};
  return { status: response.status, body: record as Record<string, unknown> };
}

const api = (operation: string): string => `/api/b/${business}/${operation.replace('.', '/')}`;
const steps: Step[] = [];
let build = '';

function finish(passed: boolean): never {
  writeFileSync(out, `${JSON.stringify({ origin, build, passed, steps }, null, 2)}\n`);
  process.stdout.write(
    `${passed ? 'passed' : 'failed'}: ${origin} build ${build || 'unknown'}, ${steps.length} steps\n`,
  );
  process.exit(passed ? 0 : 1);
}

/** Runs one step; a failed check ends the run there. */
async function step(name: string, run: () => Promise<Answer>, check: (answer: Answer) => boolean) {
  const started = Date.now();
  let answer: Answer;
  try {
    answer = await run();
  } catch {
    steps.push({ name, ok: false, ms: Date.now() - started });
    return finish(false);
  }
  const ok = answer.status === 200 && check(answer);
  const code = typeof answer.body['code'] === 'string' ? answer.body['code'] : undefined;
  steps.push({
    name,
    ok,
    status: answer.status,
    ...(code === undefined ? {} : { code }),
    ms: Date.now() - started,
  });
  if (!ok) finish(false);
  return answer;
}

await step(
  'build',
  async () => await call('/build.json'),
  (answer) => {
    const stamp = answer.body['build'];
    if (typeof stamp !== 'string' || !STAMP.test(stamp)) return false;
    build = stamp;
    return true;
  },
);

const title = `U117 journey ${build} ${randomUUID().slice(0, 8)}`;
const created = await step(
  'task.create',
  async () => await call(api('task.create'), { operationId: randomUUID(), fields: { title } }),
  (answer) => typeof answer.body['recordId'] === 'string',
);
const recordId = String(created.body['recordId']);
const taskOf = (answer: Answer) => (answer.body['task'] ?? {}) as Record<string, unknown>;

const read = await step(
  'task.read',
  async () => await call(api('task.read'), { recordId }),
  (answer) => taskOf(answer)['title'] === title,
);
const renamed = `${title} renamed`;
const updated = await step(
  'task.update',
  async () =>
    await call(api('task.update'), {
      operationId: randomUUID(),
      recordId,
      expectedRevision: taskOf(read)['revision'],
      fields: { title: renamed },
    }),
  (answer) => typeof answer.body['revision'] === 'number',
);
await step(
  'task.read renamed',
  async () => await call(api('task.read'), { recordId }),
  (answer) => taskOf(answer)['title'] === renamed,
);
await step(
  'task.trash',
  async () =>
    await call(api('task.trash'), {
      operationId: randomUUID(),
      recordId,
      expectedRevision: updated.body['revision'],
    }),
  () => true,
);
finish(true);
