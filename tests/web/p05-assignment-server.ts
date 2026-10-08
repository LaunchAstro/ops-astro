// SPDX-License-Identifier: AGPL-3.0-only
import { expect, onTestFinished } from 'vitest';
import { task } from './task-page-stub.tsx';
import {
  TASK,
  AGENT,
  TITLE,
  FIRST_PERSON,
  OWN_AGENT,
  PEOPLE,
  READS,
  json,
  refused,
  shellRead,
  digestOf,
  type RequestCopy,
  type Loss,
} from './p05-assignment-http.ts';
export {
  TASK,
  PERSON,
  OTHER,
  AGENT,
  TITLE,
  NAME,
  OWN_AGENT,
  PEOPLE,
  assignmentAnswer,
} from './p05-assignment-http.ts';
export type { RequestCopy, Loss } from './p05-assignment-http.ts';
/** HTTP-only synthetic state: whole-envelope replay and one effect, separate from current authority. */
class AssignmentServer {
  readonly writes: RequestCopy[] = [];
  readonly applications: RequestCopy[] = [];
  readonly register = new Map<string, { digest: string; answer: unknown }>();
  readonly #unexpected: string[] = [];
  #revision = 4;
  #assignee: (typeof PEOPLE)[number] | null;
  #agent: typeof OWN_AGENT | null = null;
  #writeDenied = false;
  #readDenied = false;
  #vocabularyDenied = false;
  #loss: Loss;
  #deferRead: Promise<Response> | null = null;
  #deferWrite: Promise<Response> | null = null;

  constructor(loss: Loss, initiallyAssigned: boolean) {
    this.#loss = loss;
    this.#assignee = initiallyAssigned ? FIRST_PERSON : null;
    onTestFinished(() =>
      expect(
        this.#unexpected,
        'fixture must route reads separately and reject unrelated effects',
      ).toEqual([]),
    );
  }
  revision = () => this.#revision;
  advance = () => {
    this.#revision += 1;
  };
  denyWrites = (denied: boolean) => {
    this.#writeDenied = denied;
  };
  denyReads = (denied: boolean) => {
    this.#readDenied = denied;
  };
  denyVocabulary = () => {
    this.#vocabularyDenied = true;
  };
  delayRead = (answer: Promise<Response> | null) => {
    this.#deferRead = answer;
  };
  delayWrite = (answer: Promise<Response>) => {
    this.#deferWrite = answer;
  };
  task = () =>
    task({
      id: TASK,
      key: 'Assignment-recovery',
      title: TITLE,
      revision: this.#revision,
      assignee: this.#assignee,
      agent:
        this.#agent === null ? null : { ...this.#agent, accountable: FIRST_PERSON, live: true },
      myAgents: this.#vocabularyDenied ? [] : [OWN_AGENT],
      state: { id: 's1', key: 'todo', label: 'To do', machineCategory: 'unstarted' },
      board: null,
      time: null,
      estimateMinutes: null,
    });

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : String(input),
      'http://synthetic.invalid',
    );
    const match = /^\/api\/b\/(alpha|beta)(\/.*)$/u.exec(url.pathname);
    const path = match?.[2];
    if (match?.[1] === 'beta') return this.#other(path, url.pathname);
    if (path === '/live' || path === '/live/task/' + TASK)
      return new Response(null, { status: 503 });
    if (url.pathname === '/api/session/end') return json({ ok: true });
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    return await (path === '/task/assign'
      ? this.#write({ url: url.pathname, body })
      : this.#read(path, body, url.pathname));
  };

  #other(path: string | undefined, pathname: string): Response {
    if (path === '/live' || path === '/live/task/' + TASK)
      return new Response(null, { status: 503 });
    if (READS.includes(path ?? '')) return refused('SCOPE_NOT_GRANTED');
    this.#unexpected.push(pathname);
    throw new Error('No assignment from a retired owner may reach another business');
  }
  #read(
    path: string | undefined,
    body: Readonly<Record<string, unknown>>,
    pathname: string,
  ): Response | Promise<Response> {
    const shell = shellRead(path);
    if (shell !== null) return shell;
    switch (path) {
      case '/person/list':
        return this.#vocabularyDenied
          ? refused('SCOPE_NOT_GRANTED')
          : json({ ok: true, persons: PEOPLE });
      case '/task/board':
        return this.#board();
      case '/task/read':
        return this.#taskRead(body);
      default:
        this.#unexpected.push(pathname);
        throw new Error('Unexpected assignment fixture route: ' + pathname);
    }
  }
  #board(): Response {
    return this.#readDenied
      ? refused('SCOPE_NOT_GRANTED')
      : json({
          ok: true,
          viewer: null,
          changedAt: null,
          withheld: 0,
          tasks: [
            {
              ...this.task(),
              actualMinutes: 0,
              statePosition: null,
              waitReason: null,
              awaitingDecision: false,
              comments: { client: 0, mentions: 0, latest: null },
            },
          ],
        });
  }
  #taskRead(body: Readonly<Record<string, unknown>>): Response | Promise<Response> {
    expect([TASK, 'Assignment-recovery']).toContain(body['recordId']);
    // Each HTTP read owns its body, even when two authorised refreshes share a release.
    return this.#deferRead === null
      ? this.#readDenied
        ? refused('SCOPE_NOT_GRANTED')
        : json({ ok: true, task: this.task(), states: [] })
      : this.#deferRead.then((response) => response.clone());
  }

  #write(request: RequestCopy): Response | Promise<Response> {
    this.writes.push(request);
    const { body } = request;
    const id = String(body['operationId']);
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    expect(body['recordId']).toBe(TASK);
    const digest = digestOf(request);
    const seen = this.register.get(id);
    if (seen !== undefined) return this.#replay(seen, digest);
    if (this.#writeDenied) return this.#refuse(id, digest, 'SCOPE_NOT_GRANTED');
    if (this.#loss === 'unreached') {
      this.#loss = 'none';
      throw new TypeError('Assignment never reached the synthetic server');
    }
    if (body['expectedRevision'] !== this.#revision)
      return this.#refuse(id, digest, 'VERSION_STALE');
    const answer = this.#apply(request);
    this.register.set(id, { digest, answer });
    if (this.#deferWrite !== null) return this.#deferWrite;
    if (this.#loss === 'stored') {
      this.#loss = 'none';
      throw new TypeError('Assignment answer lost after synthetic commit');
    }
    return json(answer);
  }
  #replay(seen: { digest: string; answer: unknown }, digest: string): Response {
    if (seen.digest !== digest) return refused('OPERATION_ID_REUSED');
    if (typeof seen.answer === 'object' && seen.answer !== null && 'refused' in seen.answer)
      return json(seen.answer, 403);
    return this.#writeDenied ? refused('SCOPE_NOT_GRANTED') : json(seen.answer);
  }
  #refuse(id: string, digest: string, code: string): Response {
    this.register.set(id, { digest, answer: { refused: true, code, names: [], fixes: [] } });
    return refused(code);
  }
  #apply(request: RequestCopy) {
    const fields = request.body['fields'] as { assignee?: string | null; agent?: string };
    if (fields.agent === undefined) {
      expect(Object.keys(fields)).toEqual(['assignee']);
      this.#assignee =
        fields.assignee === null
          ? null
          : (PEOPLE.find((person) => person.personId === fields.assignee) ?? null);
      this.#agent = null;
    } else {
      expect(fields).toEqual({ agent: AGENT });
      this.#agent = OWN_AGENT;
      this.#assignee = null;
    }
    this.#revision += 1;
    this.applications.push(request);
    return { recordId: TASK, revision: this.#revision, detail: {} };
  }
}
export const assignmentWorld = (loss: Loss = 'stored', initiallyAssigned = false) =>
  new AssignmentServer(loss, initiallyAssigned);
