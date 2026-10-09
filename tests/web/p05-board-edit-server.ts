// SPDX-License-Identifier: AGPL-3.0-only
import { expect, onTestFinished } from 'vitest';
import { task } from './task-page-stub.tsx';
import {
  json,
  refused,
  shellRead,
  digestOf,
  type RequestCopy,
  type Loss,
} from './p05-assignment-http.ts';
export const TASK = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const TITLE = 'Board edit recovery task';
const WRITES = new Set(['/task/update', '/task/set_stage', '/task/complete', '/task/reopen']);
interface Entry {
  id: string;
  key: string;
  title: string;
  revision: number;
  due: string | null;
  estimateMinutes: number | null;
  stage: string | null;
  completedAt: string | null;
}
/** Closed synthetic HTTP register; never counted as actual database evidence. */
export class BoardEditServer {
  readonly writes: RequestCopy[] = [];
  readonly applications: RequestCopy[] = [];
  readonly register = new Map<string, { digest: string; answer: unknown }>();
  readonly unexpected: string[] = [];
  readonly rows: Entry[] = [TASK, OTHER].map((id, index) => ({
    id,
    key: 'Board-edit-' + String(index + 1),
    title: index === 0 ? TITLE : 'Other board task',
    revision: 4,
    due: '2026-10-10',
    estimateMinutes: 30,
    stage: null,
    completedAt: null,
  }));
  #loss: Loss;
  denied = false;
  readDenied = false;
  peopleDenied = false;
  deferWrite: Promise<Response> | null = null;
  constructor(loss: Loss = 'stored') {
    this.#loss = loss;
    onTestFinished(() =>
      expect(this.unexpected, 'unrelated fixture effects must be rejected').toEqual([]),
    );
  }
  advance(id = TASK): void {
    this.row(id).revision += 1;
  }
  row(id = TASK): Entry {
    const value = this.rows.find((row) => row.id === id);
    if (value === undefined) throw new Error('Unknown fixture task');
    return value;
  }
  task(id = TASK) {
    return {
      ...task({ ...this.row(id), board: null, time: null }),
      actualMinutes: 0,
      statePosition: null,
      waitReason: null,
      awaitingDecision: false,
      comments: { client: 0, mentions: 0, latest: null },
    };
  }
  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://synthetic.invalid');
    const match = /^\/api\/b\/(alpha|beta)(\/.*)$/u.exec(url.pathname);
    const path = match?.[2];
    if (path?.startsWith('/live') || url.pathname === '/api/session/end')
      return path?.startsWith('/live') ? new Response(null, { status: 503 }) : json({ ok: true });
    if (match?.[1] === 'beta') return refused('SCOPE_NOT_GRANTED');
    const body: Record<string, unknown> = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    );
    if (WRITES.has(path ?? '')) return await this.#write({ url: url.pathname, body });
    return this.#read(path, body, url.pathname);
  };
  #read(path: string | undefined, body: Record<string, unknown>, pathname: string): Response {
    if (path === '/task/board' || path === '/task/todos') {
      if (this.readDenied) return refused('SCOPE_NOT_GRANTED');
      const rows = this.rows.map((row) => this.task(row.id));
      return json({
        ok: true,
        tasks: rows,
        todos: rows.filter((row) => row.completedAt === null),
        viewer: null,
        changedAt: null,
        withheld: 0,
      });
    }
    if (path === '/task/read') {
      if (this.readDenied) return refused('SCOPE_NOT_GRANTED');
      const found = this.rows.find(
        (row) => row.id === body['recordId'] || row.key === body['recordId'],
      );
      return found === undefined
        ? refused('RECORD_NOT_FOUND')
        : json({ ok: true, task: this.task(found.id), states: [] });
    }
    if (path === '/person/list')
      return this.peopleDenied ? refused('SCOPE_NOT_GRANTED') : json({ ok: true, persons: [] });
    const shell = shellRead(path);
    if (shell !== null) return shell;
    this.unexpected.push(pathname);
    throw new Error('Unexpected board edit fixture route: ' + pathname);
  }
  #refuse(id: string, digest: string, code: string): Response {
    this.register.set(id, { digest, answer: { refused: true, code, names: [], fixes: [] } });
    return refused(code);
  }
  #replay(seen: { digest: string; answer: unknown }, digest: string): Response {
    if (seen.digest !== digest) return refused('OPERATION_ID_REUSED');
    if (typeof seen.answer === 'object' && seen.answer !== null && 'refused' in seen.answer)
      return json(seen.answer, 403);
    return this.denied ? refused('SCOPE_NOT_GRANTED') : json(seen.answer);
  }
  async #write(request: RequestCopy): Promise<Response> {
    this.writes.push(request);
    const id = String(request.body['operationId']);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u);
    const digest = digestOf(request);
    const seen = this.register.get(id);
    if (seen !== undefined) return this.#replay(seen, digest);
    if (this.denied) return this.#refuse(id, digest, 'SCOPE_NOT_GRANTED');
    if (this.#loss === 'unreached') {
      this.#loss = 'none';
      throw new TypeError('Board edit never reached synthetic server');
    }
    const row = this.row(String(request.body['recordId']));
    if (request.body['expectedRevision'] !== row.revision)
      return this.#refuse(id, digest, 'VERSION_STALE');
    this.#apply(row, request);
    const answer = { recordId: row.id, revision: row.revision, detail: {} };
    this.register.set(id, { digest, answer });
    if (this.deferWrite !== null) return await this.deferWrite;
    if (this.#loss === 'stored') {
      this.#loss = 'none';
      throw new TypeError('Board edit response lost after synthetic commit');
    }
    return json(answer);
  }
  #apply(row: Entry, request: RequestCopy): void {
    const fields = request.body['fields'];
    if (request.url.endsWith('/task/update')) {
      expect(typeof fields).toBe('object');
      const values = fields as Record<string, unknown>;
      expect(Object.keys(values)).toHaveLength(1);
      if (typeof values['title'] === 'string') row.title = values['title'];
      else if (Object.hasOwn(values, 'due')) row.due = values['due'] as string | null;
      else if (Object.hasOwn(values, 'estimated_minutes'))
        row.estimateMinutes = values['estimated_minutes'] as number | null;
      else throw new Error('Unknown update field');
    } else if (request.url.endsWith('/task/set_stage'))
      row.stage = (fields as { stage: string }).stage;
    else if (request.url.endsWith('/task/complete')) row.completedAt = '2026-10-09T01:00:00Z';
    else {
      expect(request.url.endsWith('/task/reopen')).toBe(true);
      expect(request.body['reason']).toBe('Reopened from the Projects board');
      row.completedAt = null;
    }
    row.revision += 1;
    this.applications.push(request);
  }
}
