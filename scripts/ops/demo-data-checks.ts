// SPDX-License-Identifier: AGPL-3.0-only
//
// The demo data's safeguards (#2211), checked before a run and at every send
// (`demo-data.ts` says what each one keeps out), and the manifest that lists
// what a run made. Nothing here sends.

import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import type { CommandName } from '../../packages/core-wire/src/command-names.ts';
import { CLIENTS, TAG, TASKS, THREADS } from './demo-data-plan.ts';

/** What one send answers: the HTTP status and the parsed body. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}
export type Body = Readonly<Record<string, unknown>>;
export type Send = (verb: string, body: Body) => Promise<Answer>;

export const PREFIX = 'Demo ';
export const MAX_CEILING_MINOR = 500;
const WORKER_STEP = 'synthetic_comment';

/** A refusal this file names, as against a fault it did not expect. */
export class Refusal extends Error {}

// --- The checks ---------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/gu;
const HOST = /\b(?:https?:\/\/|www\.)([A-Za-z0-9.-]+)/giu;
const DIGIT_RUN = /\d[\d\s().+-]{4,}\d/u;

/** A reserved name (RFC 2606 and 6761): example.com/.net/.org and below, or .test. */
export function reservedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, '');
  return /(?:^|\.)example\.(?:com|net|org)$/u.test(name) || /(?:^|\.)test$/u.test(name);
}

/** What is wrong with one piece of text: an unreserved address or host, or a phone-like number. */
export function textProblems(text: string): readonly string[] {
  const problems: string[] = [];
  for (const [, host] of text.matchAll(EMAIL)) {
    if (host === undefined || !reservedHost(host))
      problems.push(`an address outside example.com/.test: ${text}`);
  }
  for (const [, host] of text.matchAll(HOST)) {
    if (host === undefined || !reservedHost(host))
      problems.push(`a website outside example.com/.test: ${text}`);
  }
  const digits = DIGIT_RUN.exec(text)?.[0];
  if (digits !== undefined && digits.replaceAll(/\D/gu, '').length >= 6) {
    problems.push(`a phone-like number: ${text}`);
  }
  return problems;
}

/** The keys whose values people read; ids, dates and operation ids are not among them. */
const TEXT_KEYS: ReadonlySet<string> = new Set([
  'name',
  'title',
  'description',
  'agent_brief',
  'brief',
  'body',
  'comments',
  'note',
  'plan',
  'steps',
]);

/** Every string under a text key, at any depth. */
function strings(value: unknown, key = 'body'): readonly string[] {
  if (typeof value === 'string') return TEXT_KEYS.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => strings(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, k));
  }
  return [];
}

/** Every problem in the plan itself; empty when it may run. */
export function planProblems(): readonly string[] {
  const named = [...CLIENTS, ...TASKS.map((t) => t.title), ...THREADS.map((t) => t.title)];
  const clientOf = new Map(TASKS.map((t) => [t.title, t.client]));
  return [
    ...named.filter((name) => !name.startsWith(PREFIX)).map((name) => `not named Demo: ${name}`),
    ...strings({ name: [...CLIENTS, TAG], body: [TASKS, THREADS] }).flatMap((t) => textProblems(t)),
    ...TASKS.filter((t) => t.client !== null && !CLIENTS.includes(t.client)).map(
      (t) => `an unknown client for ${t.title}`,
    ),
    ...THREADS.filter((t) => (clientOf.get(t.task) ?? null) === null).map(
      (t) => `a thread not on a task with a client: ${t.title}`,
    ),
  ];
}

/** The commands a demo run may send, and nothing else. */
export const ALLOWED: ReadonlySet<string> = new Set([
  'session.capabilities',
  'client.create',
  'tag.create',
  'task.create',
  'task.set_party',
  'task.add_tag',
  'task.comment',
  'task.start',
  'task.complete',
  'task.propose',
  'task.decide',
  'conversation.start',
  'task.read',
  'task.search',
  'task.trash',
]);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'mentions',
  'assignee',
  'delegate',
  'page_link',
  'model',
]);

/** The grants the allowed commands are declared with (`core-wire/src/surface.ts`), read from there. */
export const NEEDED: readonly string[] = [
  ...new Set(
    [...ALLOWED]
      .filter((name) => name !== 'session.capabilities')
      .map((name) => declarationOf(name as CommandName))
      .map((d) => `${d.collection}:${d.action}`),
  ),
];

/**
 * A send that refuses, before anything leaves, a body the safeguards forbid.
 * `ours` holds every id this run made or read from its manifest; a targeted
 * write must name one of them, and a decision one of its own gates.
 */
export function guarded(send: Send, ours: ReadonlySet<string>, gates: ReadonlySet<string>): Send {
  return async (verb, body) => {
    const problem = sendProblem(verb, body, ours, gates);
    if (problem !== undefined) throw new Refusal(`${verb}: ${problem}`);
    return await send(verb, body);
  };
}

function sendProblem(
  verb: string,
  body: Body,
  ours: ReadonlySet<string>,
  gates: ReadonlySet<string>,
): string | undefined {
  if (!ALLOWED.has(verb)) return 'not a command a demo run sends';
  const keys = [...Object.keys(body), ...Object.keys((body['fields'] as Body | undefined) ?? {})];
  const forbidden = keys.find((key) => FORBIDDEN_KEYS.has(key));
  if (forbidden !== undefined) return `carries '${forbidden}'`;
  const text = strings(body).flatMap((t) => textProblems(t))[0];
  if (text !== undefined) return text;
  const target = body['recordId'];
  if (target !== undefined && !ours.has(String(target)))
    return 'names a record this run did not make';
  if (verb === 'task.comment' && body['audience'] !== 'internal')
    return 'a comment must be internal';
  if (verb === 'task.decide' && !gates.has(String(body['gateId'])))
    return 'a gate this run did not open';
  if (verb === 'task.propose') {
    const ceiling = body['maximumMinor'];
    if (typeof ceiling !== 'number' || ceiling > MAX_CEILING_MINOR) return 'a ceiling over AUD 5';
    if ((body['step'] as Body | undefined)?.['kind'] === WORKER_STEP)
      return "the worker's own step";
  }
  if (verb === 'conversation.start') {
    const scope = body['scope'] as Body | undefined;
    if (scope?.['kind'] !== 'task' || !ours.has(String(scope['id']))) return 'not on a demo task';
  }
  return undefined;
}

// --- The manifest -------------------------------------------------------

export interface Made {
  readonly step: string;
  readonly kind: 'client' | 'tag' | 'task' | 'comment' | 'proposal' | 'thread' | 'state';
  readonly id: string;
  readonly name?: string;
  /** The task's revision after this step, for the next step on it. */
  readonly revision?: number;
  readonly gateId?: string;
  readonly versionId?: string;
}

export interface Manifest {
  readonly version: 1;
  readonly batch: string;
  readonly business: string;
  readonly api: string;
  /** Fixed at the first run, so a rerun sends the same due dates and replays. */
  readonly createdAt: string;
  readonly made: Made[];
}

export const op = (manifest: Manifest, key: string): string => `demo-data:${manifest.batch}:${key}`;

/** The answer's body when it is a success; a refusal otherwise. */
export function applied(answer: Answer, verb: string): Body {
  const body = (answer.body ?? {}) as Body;
  if (answer.status !== 200 || body['refused'] === true) {
    throw new Refusal(
      `${verb} answered ${String(answer.status)} ${String(body['code'] ?? '')}`.trim(),
    );
  }
  return body;
}

export const inner = (answer: Body): Body => (answer['detail'] ?? {}) as Body;
