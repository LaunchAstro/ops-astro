// SPDX-License-Identifier: AGPL-3.0-only
// Private, unexecuted mounted fixture. This register models one effect, not real DB proof.
import { isDeepStrictEqual } from 'node:util';
import { task } from './task-page-stub.tsx';
import { shellRead } from './p05-assignment-http.ts';

export type Body = Readonly<Record<string, unknown>>;
export interface Sent {
  readonly business: string;
  readonly path: string;
  readonly body: Body;
}
interface Receipt {
  readonly recordId: string;
  readonly revision: number;
  readonly detail: Body;
}
interface Stored {
  readonly request: Sent;
  readonly answer: Receipt;
}
interface Made {
  readonly business: string;
  readonly person: string;
  readonly id: string;
  readonly title: string;
  revision: number;
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const refusal = (code: string): Response =>
  json({ refused: true, code, names: [], fixes: [] }, code === 'SCOPE_NOT_GRANTED' ? 403 : 409);
const MUTATIONS = new Set(['/task/create']);
const idle = (): void => undefined;

export class CreateServer {
  readonly sent: Sent[] = [];
  readonly unexpected: string[] = [];
  readonly applied: Sent[] = [];
  readonly tasks: Made[] = [];
  readonly #register = new Map<string, Stored>();
  #loss: { path: string; at: 'before' | 'after' } | null = null;
  #hold: { path: string; promise: Promise<void> } | null = null;
  #person = 'draft-entry@example.test';
  denied = false;
  readonly deniedPaths = new Set<string>();
  boardDenied = false;
  taskDenied = false;
  afterApplied: () => void = () => {};

  lose(path: string, at: 'before' | 'after'): void {
    this.#loss = { path, at };
  }
  person(next: string): void {
    this.#person = next;
  }
  hold(path: string): () => void {
    let release = idle;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#hold = { path, promise };
    return release;
  }
  commands(path: string): readonly Sent[] {
    return this.sent.filter((one) => one.path === path);
  }

  fetch: typeof globalThis.fetch = async (url, init) => {
    const pathname = new URL(String(url), 'http://fixture.test').pathname;
    const found = /^\/api\/b\/([^/]+)(\/.*)$/u.exec(pathname);
    if (pathname.includes('/live')) return new Response('', { status: 503 });
    if (pathname === '/api/session/end')
      return json({ recordId: null, revision: null, detail: {} });
    if (found === null) throw new Error(`unrouted fixture URL ${pathname}`);
    const request = {
      business: decodeURIComponent(found[1]!),
      path: found[2]!,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body,
    };
    this.sent.push(request);
    return MUTATIONS.has(request.path) ? await this.#mutate(request) : this.#read(request);
  };

  #read(request: Sent): Response {
    const { business, path, body } = request;
    const shell = shellRead(path);
    if (shell !== null) return shell;
    switch (path) {
      case '/preference/read':
        return json({ ok: true, preferences: {} });
      case '/client/list':
        return json({ ok: true, clients: [] });
      case '/person/list':
        return json({ ok: true, persons: [] });
      case '/tag/list':
        return json({ ok: true, tags: [] });
      case '/task/queue':
        return json({ ok: true, queue: [], alerts: [], outages: [] });
      case '/task/board':
        return this.#board(business);
      case '/task/read':
        return this.#taskRead(business, body);
      default:
        this.unexpected.push(path);
        throw new Error(`unrouted fixture read ${path}`);
    }
  }

  #board(business: string): Response {
    if (this.boardDenied) return refusal('SCOPE_NOT_GRANTED');
    const tasks = this.tasks
      .filter((made) => made.business === business && made.person === this.#person)
      .map((made) =>
        Object.assign(this.#detail(made), {
          actualMinutes: 0,
          statePosition: null,
          waitReason: null,
          awaitingDecision: false,
          comments: { client: 0, mentions: 0, latest: null },
        }),
      );
    return json({ ok: true, viewer: null, tasks });
  }

  #taskRead(business: string, body: Body): Response {
    if (this.taskDenied) return refusal('SCOPE_NOT_GRANTED');
    const made = this.tasks.find(
      (one) =>
        one.business === business &&
        one.person === this.#person &&
        (one.id === body['recordId'] || `Created-${one.id}` === body['recordId']),
    );
    return made === undefined ? refusal('NOT_FOUND') : json({ ok: true, task: this.#detail(made) });
  }

  #detail(made: Made) {
    return task({
      id: made.id,
      key: `Created-${made.id}`,
      title: made.title,
      revision: made.revision,
      time: null,
    });
  }

  async #mutate(request: Sent): Promise<Response> {
    const loss = this.#loss?.path === request.path ? this.#loss : null;
    if (loss !== null) this.#loss = null;
    if (loss?.at === 'before') throw new TypeError('P05 lost before admission');
    // Current grant is checked independently of a stored success.
    if (this.denied || this.deniedPaths.has(request.path)) return refusal('SCOPE_NOT_GRANTED');
    const key = `${request.business}:${this.#person}:${String(request.body['operationId'])}`;
    const stored = this.#register.get(key);
    if (stored !== undefined && !isDeepStrictEqual(stored.request, request))
      return refusal('OPERATION_ID_REUSED');
    const answer = stored?.answer ?? this.#apply(request);
    if (stored === undefined) {
      this.#register.set(key, { request, answer });
      this.applied.push(request);
      this.afterApplied();
    }
    const held = this.#hold?.path === request.path ? this.#hold : null;
    if (held !== null) {
      this.#hold = null;
      await held.promise;
    }
    if (loss?.at === 'after') throw new TypeError('P05 lost after fixture commit');
    return json(answer);
  }

  #apply(request: Sent): Receipt {
    const { business, path, body } = request;
    if (path === '/task/create') {
      const id = `11111111-1111-4111-8111-${String(this.tasks.length + 1).padStart(12, '0')}`;
      const fields = body['fields'] as Body;
      this.tasks.push({
        business,
        person: this.#person,
        id,
        title: String(fields['title']),
        revision: 1,
      });
      return { recordId: id, revision: 1, detail: { key: `Created-${id}` } };
    }
    const made = this.tasks.find(
      (one) => one.business === business && one.id === (body['recordId'] ?? body['taskId']),
    );
    if (made === undefined) throw new Error('fixture phase target does not exist');
    if (path === '/task/set_category') made.revision += 1;
    // Canonical task.comment returns its target revision; it does not bump the task.
    return { recordId: made.id, revision: made.revision, detail: {} };
  }
}
