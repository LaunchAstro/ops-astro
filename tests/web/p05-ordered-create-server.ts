// SPDX-License-Identifier: AGPL-3.0-only
// Finite canonical-shaped synthetic register. This is App composition proof, not DB proof.
import { isDeepStrictEqual } from 'node:util';
import { CreateServer, type Body, type Sent } from './p05-inline-create-server.ts';

interface Receipt {
  readonly recordId: string | null;
  readonly revision: number | null;
  readonly detail: Body;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refused = (code: string) => json({ refused: true, code, names: [], fixes: [] }, 409);
const WRITE = new Set([
  '/task/create',
  '/task/set_party',
  '/task/set_category',
  '/task/assign',
  '/task/comment',
  '/tag/create',
  '/task/add_tag',
  '/time/log',
]);
const uuid = (kind: number, count: number) =>
  `${String(kind).padStart(8, '0')}-1111-4111-8111-${String(count).padStart(12, '0')}`;

export class OrderedCreateServer {
  readonly reader = new CreateServer();
  readonly sent: Sent[] = [];
  readonly applied: Sent[] = [];
  readonly unexpected = this.reader.unexpected;
  readonly tags: { id: string; name: string }[] = [];
  readonly deniedPaths = new Set<string>();
  readonly children: string[] = [];
  readonly #register = new Map<string, { request: Sent; receipt: Receipt }>();
  #person = 'draft-entry@example.test';
  #loss: { path: string; at: 'before' | 'after'; occurrence: number } | null = null;
  #hold: { path: string; promise: Promise<void> } | null = null;
  tagListDenied = false;
  boardDenied = false;
  taskDenied = false;
  denied = false;
  distort: ((receipt: Receipt, request: Sent) => unknown) | null = null;
  afterApplied: (request: Sent) => void = () => {};
  get parents() {
    return this.reader.tasks.filter((one) => !this.children.includes(one.id));
  }
  person(next: string): void {
    this.#person = next;
    this.reader.person(next);
  }
  commands(path: string) {
    return this.sent.filter((one) => one.path === path);
  }
  writes() {
    return this.sent.filter((one) => WRITE.has(one.path));
  }
  lose(path: string, at: 'before' | 'after', occurrence = 1): void {
    this.#loss = { path, at, occurrence };
  }
  hold(path: string): () => void {
    let release = idle;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#hold = { path, promise };
    return release;
  }
  fetch: typeof globalThis.fetch = async (url, init) => {
    const where = new URL(String(url), 'http://fixture.test');
    if (where.pathname.includes('/live') || where.pathname === '/api/session/end')
      return this.reader.fetch(url, init);
    const found = /^\/api\/b\/([^/]+)(\/.*)$/u.exec(where.pathname);
    if (found === null) throw new Error(`Unrouted ordered fixture ${where.pathname}`);
    const request: Sent = {
      business: decodeURIComponent(found[1]!),
      path: found[2]!,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body,
    };
    this.sent.push(request);
    if (!WRITE.has(request.path)) {
      if (request.path === '/tag/list') {
        await this.#wait(request.path);
        return this.tagListDenied
          ? refused('SCOPE_NOT_GRANTED')
          : json({ ok: true, tags: this.tags });
      }
      this.reader.boardDenied = this.boardDenied;
      this.reader.taskDenied = this.taskDenied;
      return this.reader.fetch(url, init);
    }
    const id = request.body['operationId'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(id))
      return refused('OPERATION_ID_REQUIRED');
    let loss: 'before' | 'after' | null = null;
    if (this.#loss?.path === request.path) {
      this.#loss.occurrence -= 1;
      if (this.#loss.occurrence === 0) {
        loss = this.#loss.at;
        this.#loss = null;
      }
    }
    if (loss === 'before') throw new TypeError('Ordered response lost before admission');
    if (this.denied || this.deniedPaths.has(request.path)) return refused('SCOPE_NOT_GRANTED');
    const key = `${request.business}:${this.#person}:${id}`;
    const previous = this.#register.get(key);
    if (previous !== undefined && !isDeepStrictEqual(previous.request, request))
      return refused('OPERATION_ID_REUSED');
    const receipt = previous?.receipt ?? this.#apply(request);
    if (previous === undefined) {
      this.#register.set(key, { request, receipt });
      this.applied.push(request);
      this.afterApplied(request);
    }
    await this.#wait(request.path);
    if (loss === 'after') throw new TypeError('Ordered response lost after fixture commit');
    return json(this.distort?.(receipt, request) ?? receipt);
  };
  async #wait(path: string): Promise<void> {
    const held = this.#hold?.path === path ? this.#hold : null;
    if (held !== null) {
      this.#hold = null;
      await held.promise;
    }
  }
  #apply(request: Sent): Receipt {
    const { business, path, body } = request;
    if (path === '/tag/create') {
      const id = uuid(2, this.tags.length + 1);
      this.tags.push({ id, name: String(body['name']) });
      return { recordId: null, revision: null, detail: { tagId: id } };
    }
    if (path === '/task/create') {
      const id = uuid(1, this.reader.tasks.length + 1);
      const fields = body['fields'] as Body;
      this.reader.tasks.push({
        business,
        person: this.#person,
        id,
        title: String(fields['title']),
        revision: 1,
      });
      if (body['parentId'] !== undefined) this.children.push(id);
      return { recordId: id, revision: 1, detail: { key: `Created-${id}` } };
    }
    const parent = this.reader.tasks.find(
      (one) => one.business === business && one.id === (body['recordId'] ?? body['taskId']),
    );
    if (parent === undefined) throw new Error('Ordered fixture phase has no target');
    if (['/task/set_party', '/task/set_category', '/task/assign', '/task/comment'].includes(path)) {
      if (body['expectedRevision'] !== parent.revision)
        throw new Error(`Wrong parent cursor on ${path}`);
      if (path !== '/task/comment') parent.revision += 1;
      return {
        recordId: parent.id,
        revision: parent.revision,
        detail: path === '/task/comment' ? { commentId: uuid(3, this.applied.length + 1) } : {},
      };
    }
    if (path === '/task/add_tag')
      return { recordId: parent.id, revision: null, detail: { tagId: body['tagId'] } };
    if (path === '/time/log')
      return {
        recordId: null,
        revision: null,
        detail: {
          entryId: uuid(4, this.applied.length + 1),
          minutes: body['duration'] === '1h 15m' ? 75 : leadingInteger(body['duration']),
        },
      };
    throw new Error(`Unexpected ordered write ${path}`);
  }
}

const idle = (): void => {};
const leadingInteger = (value: unknown): number =>
  Number(/^[+-]?\d+/u.exec(String(value).trimStart())?.[0] ?? Number.NaN);
