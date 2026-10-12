// SPDX-License-Identifier: AGPL-3.0-only
//
// A run of the slice verifier (`scripts/local/verify-slice.mjs`) against an API
// and a GoTrue made here, in memory: enough of the surface for the script's
// whole walk, keeping every promise it answers unless a fault says otherwise.
// The script reads `.local/` beside its own checkout, so it runs from a copy in
// a scratch tree that holds the synthetic logins and nothing else.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll } from 'vitest';

type Json = Record<string, unknown>;

/** The one promise the API breaks, if any. */
export interface Faults {
  /** Every task write answers applied and changes nothing. */
  readonly inertWrites?: true;
  /** A created task has no state until something moves it. */
  readonly statelessCreate?: true;
}

const STATES = {
  unstarted: { id: 'state-1', key: 'todo', label: 'To do', machineCategory: 'unstarted' },
  started: { id: 'state-2', key: 'active', label: 'Active', machineCategory: 'started' },
  completed: { id: 'state-3', key: 'complete', label: 'Complete', machineCategory: 'completed' },
} as const;

const LOGINS = ['mia@alpha.local', 'noah@alpha.local', 'bea@bravo.local', 'ada@alpha.local'];
const USERS = [...LOGINS, 'orphan@alpha.local'].map((email) => ({
  email,
  password: 'synthetic',
  person: email.split('@')[0],
  subject: `subject-${email}`,
}));
const AGENT = 'olive@alpha.local';

interface Task {
  readonly id: string;
  readonly key: string;
  title: unknown;
  due: unknown;
  priority: unknown;
  state: Json | null;
  assignee: Json | null;
  completedAt: string | null;
  revision: number;
  readonly history: Json[];
  readonly proposals: { lineageId: string; versions: Json[] }[];
}

type Answer = [number, Json];

const fieldsOf = (body: Json): Json => (body['fields'] ?? {}) as Json;
const NOT_FOUND: Answer = [404, { code: 'NOT_FOUND' }];

/** An in-memory slice: enough of the surface for the script's whole walk. */
class FakeSlice {
  readonly #tasks = new Map<string, Task>();
  readonly #gates = new Map<string, { versionId: string; taskId: string }>();
  readonly #queue: Json[] = [];
  #picked: string | undefined;

  readonly faults: Faults;

  constructor(faults: Faults) {
    this.faults = faults;
  }

  answer(op: string, who: string, body: Json, agent: boolean): Answer {
    if (agent) return this.#agent(op, body);
    if (op === 'person/list')
      return [200, { ok: true, persons: [{ personId: 'p-noah', name: 'noah' }] }];
    if (op === 'task/create') return this.#create(who, body);
    if (op === 'task/board') return [200, { ok: true, tasks: [...this.#tasks.values()] }];
    if (op === 'task/queue') return [200, { ok: true, queue: this.#queue }];
    if (op === 'task/decide') return this.#decide(body);
    const task = this.#found(body);
    if (task === undefined) return NOT_FOUND;
    if (op === 'task/read') return [200, { ok: true, task }];
    if (op === 'task/propose') return this.#propose(task, body);
    const change = this.#change(op, task, fieldsOf(body));
    if (change === undefined) return NOT_FOUND;
    if (
      op === 'task/update' &&
      Object.keys(fieldsOf(body)).some((name) => !['title', 'due', 'priority'].includes(name))
    )
      return [422, { code: 'FIELD_NOT_WRITABLE' }];
    const revision = task.revision + 1;
    if (this.faults.inertWrites === undefined) {
      change();
      task.revision = revision;
      task.history.push({ actorId: who });
    }
    return [200, { ok: true, recordId: task.id, revision }];
  }

  #found(body: Json): Task | undefined {
    return [...this.#tasks.values()].find(
      (task) => task.id === body['recordId'] || task.key === body['recordId'],
    );
  }

  #change(op: string, task: Task, fields: Json): (() => void) | undefined {
    const moves: Record<string, () => void> = {
      'task/assign': () => {
        task.assignee = { personId: fields['assignee'], name: 'noah' };
      },
      'task/start': () => {
        task.state = STATES.started;
      },
      'task/complete': () => {
        task.state = STATES.completed;
        task.completedAt = new Date().toISOString();
      },
      'task/reopen': () => {
        task.state = STATES.unstarted;
        task.completedAt = null;
      },
      'task/update': () => {
        Object.assign(task, fields);
      },
    };
    return moves[op];
  }

  #create(who: string, body: Json): Answer {
    const id = randomUUID();
    this.#tasks.set(id, {
      id,
      key: `T-${this.#tasks.size + 1}`,
      title: fieldsOf(body)['title'],
      due: null,
      priority: null,
      state: this.faults.statelessCreate === undefined ? STATES.unstarted : null,
      assignee: null,
      completedAt: null,
      revision: 1,
      history: [{ actorId: who }],
      proposals: [],
    });
    return [200, { ok: true, recordId: id, revision: 1 }];
  }

  #propose(task: Task, body: Json): Answer {
    const versionId = randomUUID();
    const gateId = randomUUID();
    this.#gates.set(gateId, { versionId, taskId: task.id });
    const lineageId = String(body['lineageId'] ?? randomUUID());
    let lineage = task.proposals.find((one) => one.lineageId === lineageId);
    if (lineage === undefined) {
      lineage = { lineageId, versions: [] };
      task.proposals.push(lineage);
    }
    lineage.versions.unshift({
      versionId,
      payloadDigest: 'a'.repeat(64),
      evidence: { renderer: 'core-runtime/evidence@1' },
      gate: { id: gateId, state: 'open' },
    });
    return [200, { ok: true, detail: { versionId, gateId, lineageId, version: 1 } }];
  }

  #decide(body: Json): Answer {
    const gate = this.#gates.get(String(body['gateId']));
    if (gate === undefined || gate.versionId !== body['versionId'])
      return [409, { code: 'VERSION_SUPERSEDED' }];
    const reservationId = randomUUID();
    this.#queue.push({ reservationId, taskId: gate.taskId, purpose: 'draft_the_reply' });
    return [200, { ok: true, detail: { reservationId } }];
  }

  #agent(op: string, body: Json): Answer {
    if (op === 'task/queue') return [200, { ok: true, detail: { queue: this.#queue } }];
    if (op === 'task/pickup') {
      const entry = this.#queue.find((one) => one['reservationId'] === body['reservationId']);
      this.#picked = String(entry?.['taskId']);
      return [200, { ok: true, detail: { credential: 'live', leaseId: 'lease', fence: 1 } }];
    }
    if (op === 'task/read') {
      if (this.#picked === undefined) return [403, { code: 'DELEGATION_EXCLUDES_OPERATION' }];
      const task = this.#found(body);
      if (task?.id !== this.#picked) return [403, { code: 'DELEGATION_OUT_OF_PURPOSE' }];
      return [200, { ok: true, task }];
    }
    if (op === 'task/handback') {
      this.#queue.splice(0);
      return [200, { ok: true }];
    }
    return NOT_FOUND;
  }
}

async function bodyOf(request: IncomingMessage): Promise<Json> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text === '' ? {} : (JSON.parse(text) as Json);
}

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'verify-slice-'));

/** The script's own copy, beside a `.local/` holding the synthetic logins. */
beforeAll(() => {
  mkdirSync(join(scratch, 'scripts/local'), { recursive: true });
  mkdirSync(join(scratch, 'packages/core-records/src'), { recursive: true });
  mkdirSync(join(scratch, '.local'));
  copyFileSync('scripts/local/verify-slice.mjs', join(scratch, 'scripts/local/verify-slice.mjs'));
  copyFileSync(
    'packages/core-records/src/env-file.ts',
    join(scratch, 'packages/core-records/src/env-file.ts'),
  );
  writeFileSync(join(scratch, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(scratch, '.local/synthetic-users.json'), JSON.stringify(USERS));
  writeFileSync(
    join(scratch, '.local/synthetic-agents.json'),
    JSON.stringify([{ business: 'alpha', email: AGENT, password: 'synthetic' }]),
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The answer to one request: GoTrue's, the health check's, or the slice's. */
async function answerFor(slice: FakeSlice, request: IncomingMessage): Promise<Answer> {
  const body = await bodyOf(request);
  const path = new URL(request.url ?? '/', 'http://fake').pathname;
  const who = (request.headers.authorization ?? '').replace(/^Bearer /u, '');
  if (path === '/token') return [200, { access_token: String(body['email']) }];
  if (path === '/api/health') return [200, { ok: true, database: 'up' }];
  const [, agent, business, op] = /^\/api\/(a\/)?b\/([a-z]+)\/(.+)$/u.exec(path) ?? [];
  if (who === '' || business !== 'alpha' || (agent !== undefined) !== (who === AGENT))
    return [403, { code: 'AUTH_NO_MEMBERSHIP' }];
  return slice.answer(op ?? '', who, body, agent !== undefined);
}

async function respond(slice: FakeSlice, request: IncomingMessage, response: ServerResponse) {
  const [status, body] = await answerFor(slice, request);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Each row's verdict, `pass`, `FAIL` or `unrun`, by its name. */
export async function verify(faults: Faults): Promise<Map<string, string>> {
  const slice = new FakeSlice(faults);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void respond(slice, request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { stdout } = await run(process.execPath, ['scripts/local/verify-slice.mjs'], {
      cwd: scratch,
      env: { PATH: process.env['PATH'] ?? '', API_URL: url, GOTRUE_URL: url },
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
    const rows = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const verdict = line.slice(0, 5).trim();
      if (['pass', 'FAIL', 'unrun'].includes(verdict))
        rows.set(line.slice(7).split('  ')[0] ?? '', verdict);
    }
    return rows;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}
