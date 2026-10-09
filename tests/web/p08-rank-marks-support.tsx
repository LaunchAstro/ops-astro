// SPDX-License-Identifier: AGPL-3.0-only
import { draftReply, ID, type Sent } from './projects-draft-app-support.tsx';
import { task } from './task-page-stub.tsx';
import { response, refusal } from './internal-task-mentions-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { chooseHouse } from './p08-rank-marks-select-support.tsx';

export const KEY = 'Rank-marks';
const SIDE_READS = new Set([
  '/inbox/count',
  '/chat/conversations',
  '/session/person',
  '/task/execution',
]);
const READS = new Set(['/preference/read', '/client/list', '/person/list', '/task/queue']);
type Scores = { impact: number | null; confidence: number | null; ease: number | null };
type Mode = 'known' | 'lost-before' | 'lost-after';
class MarksServer {
  readonly sent: Sent[] = [];
  readonly unexpected: string[] = [];
  readonly #stored = new Map<string, Response>();
  readonly #mode: Mode;
  #effects = 0;
  #denial = false;
  #readDenial = false;
  #revision = 4;
  #scores: Scores = { impact: 7, confidence: 9, ease: 8 };
  constructor(mode: Mode) {
    this.#mode = mode;
  }
  writes = () => this.sent.filter((one) => one.path === '/task/set_scores');
  effects = () => this.#effects;
  deny(value: boolean): void {
    this.#denial = value;
  }
  denyRead(value: boolean): void {
    this.#readDenial = value;
  }
  #write(body: Record<string, unknown>): Response {
    const operation = String(body['operationId']);
    if (this.#denial) {
      const denied = refusal('SCOPE_NOT_GRANTED');
      if (!this.#stored.has(operation)) this.#stored.set(operation, denied.clone());
      return denied;
    }
    const replay = this.#stored.get(operation);
    if (replay !== undefined) return replay.clone();
    const first = this.writes().length === 1;
    if (first && this.#mode === 'lost-before')
      return new Response('lost before apply', { status: 503 });
    this.#scores = { ...this.#scores, ...(body['fields'] as Partial<Scores>) };
    this.#revision += 1;
    this.#effects += 1;
    const answer = response({ recordId: ID, revision: this.#revision });
    this.#stored.set(operation, answer.clone());
    return first && this.#mode === 'lost-after'
      ? new Response('lost after apply', { status: 503 })
      : answer;
  }
  #reply(url: RequestInfo | URL, init?: RequestInit): Response {
    const path = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    this.sent.push({ path, body });
    if (path.startsWith('/api/b/alpha/live?') || SIDE_READS.has(path))
      return new Response('Unavailable in isolated marks fixture', { status: 503 });
    if (path === '/task/set_scores') return this.#write(body);
    if (path === '/task/read')
      return this.#readDenial
        ? refusal('SCOPE_NOT_GRANTED')
        : response({
            ok: true,
            task: task({ id: ID, key: KEY, scores: this.#scores, revision: this.#revision }),
            states: [],
          });
    if (path === '/task/board') return response({ ok: true, tasks: [], viewer: null });
    if (path === '/tag/list') return response({ ok: true, tags: [] });
    if (READS.has(path)) return draftReply({ path, body });
    this.unexpected.push(path);
    throw new Error('Unexpected rank fixture route ' + path);
  }
  fetch: typeof globalThis.fetch = (url, init) =>
    Promise.resolve().then(() => this.#reply(url, init));
}
export const marksWorld = (mode: Mode = 'known') => new MarksServer(mode);
export async function chooseMark(
  view: Mounted,
  scope: 'page' | 'panel',
  mark: string,
  value: string,
) {
  const trigger = view.host.querySelector<HTMLButtonElement>(
    '#' + scope + '-score-' + mark + ' button',
  );
  if (trigger === null) throw new Error('No accessible ' + scope + ' score editor for ' + mark);
  await chooseHouse(trigger, value);
}
