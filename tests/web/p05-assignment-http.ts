// SPDX-License-Identifier: AGPL-3.0-only
export const TASK = '11111111-1111-4111-8111-111111111111';
export const PERSON = '00000000-0000-4000-8000-000000000012';
export const OTHER = '00000000-0000-4000-8000-000000000013';
export const AGENT = '00000000-0000-4000-8000-000000000014';
export const TITLE = 'Assignment recovery synthetic task';
export const NAME = 'Synthetic assignee';
export const OWN_AGENT = { delegationId: AGENT, purpose: 'Synthetic own-agent work' };
export const FIRST_PERSON = { personId: PERSON, name: NAME };
export const PEOPLE = [FIRST_PERSON, { personId: OTHER, name: 'Synthetic next assignee' }];
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const refused = (code: string) => json({ refused: true, code, names: [], fixes: [] }, 403);
export const READS = [
  '/preference/read',
  '/client/list',
  '/person/list',
  '/task/queue',
  '/task/read',
  '/task/board',
  '/task/todos',
  '/task/execution',
  '/tag/list',
  '/inbox/count',
  '/chat/conversations',
  '/session/person',
  '/inbox/read',
];
export interface RequestCopy {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}
export type Loss = 'stored' | 'unreached' | 'none';

const SHELL_READS = new Map<string, () => Response>([
  ['/inbox/read', unavailable],
  ['/inbox/count', unavailable],
  ['/chat/conversations', unavailable],
  ['/session/person', unavailable],
  ['/preference/read', () => json({ ok: true, preferences: {} })],
  ['/client/list', () => json({ ok: true, clients: [] })],
  ['/session/end', () => json({ recordId: null, revision: null, detail: {} })],
  ['/account/sessions/sign-out', () => json({ ok: true })],
  ['/task/todos', () => json({ ok: true, tasks: [], viewer: null, changedAt: null, withheld: 0 })],
  ['/task/queue', () => json({ ok: true, queue: [], alerts: [], outages: [] })],
  ['/task/execution', () => json({ ok: false })],
  ['/tag/list', () => json({ ok: true, tags: [] })],
]);
function unavailable(): Response {
  return new Response(null, { status: 503 });
}
export function shellRead(path: string | undefined): Response | null {
  const read = SHELL_READS.get(path ?? '');
  return read === undefined ? null : read();
}
export function digestOf(request: RequestCopy): string {
  const { operationId: _id, ...payload } = request.body;
  return JSON.stringify({
    url: request.url,
    payload: Object.fromEntries(
      Object.entries(payload).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  });
}
export const assignmentAnswer = () => json({ recordId: TASK, revision: 5, detail: {} });
