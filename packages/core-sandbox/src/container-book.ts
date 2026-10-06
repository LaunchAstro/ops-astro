// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy's
// durable container record. It holds at most one container (B7: one
// sandbox at a time). A create needs an empty record and a daemon count of
// zero; a count that differs from the record refuses the create, and the
// caller starts a sweep. Run operations take only the recorded full id.
//
// The deadline runs from the durable create record, so a container never
// started has one too. The kill is due at the deadline until it lands (a
// kill refused because the container is not running counts as landed) or
// the wait returns. The delete is due 30 s after the later of the wait
// returning and the attach ending, 30 s after the launcher fully closes
// its attach before the wait returns, and at the latest 30 s after the
// deadline; a `wall` crossing's container (the probe's) not before then. The id
// leaves only on a delete answered success or "no such container"; any
// other answer keeps it and the caller sweeps.
//
// The record is read back as text, so `readContainerBook` is a closed
// reader: exact keys, the full id, counts and booleans of their own type.

import { CONTAINER_ID } from './proxy-request.ts';
import { fault, refuse, type SandboxResult } from './refusal.ts';
import { hasExactKeys, isJsonObject, type Json, parseStrictJson } from './strict-json.ts';

export type Recorded = {
  readonly id: string;
  readonly createdAt: number;
  readonly deadline: number;
  readonly wall: boolean;
  readonly killed: boolean;
  readonly waitAt: number | null;
  readonly attachAt: number | null;
  readonly closedAt: number | null;
};
export type ContainerBook = { readonly container: Recorded | null };
export type KillAnswer = 'landed' | 'not running' | 'failed';
export type DeleteAnswer = 'removed' | 'no such container' | 'failed';

/** P4 and P6's 30 s. */
export const GRACE_MS = 30_000;
export const EMPTY_CONTAINERS: ContainerBook = { container: null };

export function admitContainerCreate(
  book: ContainerBook,
  daemonCount: number,
): SandboxResult<object> {
  if (book.container !== null) return refuse('container record');
  return daemonCount === 0 ? { ok: true } : refuse('container count');
}

export const admitContainerOp = (book: ContainerBook, id: string): SandboxResult<object> =>
  book.container?.id === id ? { ok: true } : refuse('container id');

export const recordContainer = (
  book: ContainerBook,
  id: string,
  now: number,
  wallMs: number,
  wall: boolean,
): ContainerBook =>
  book.container === null
    ? {
        container: {
          id,
          createdAt: now,
          deadline: now + wallMs,
          wall,
          killed: false,
          waitAt: null,
          attachAt: null,
          closedAt: null,
        },
      }
    : book;

/** The book with the held container changed by `step`, or as it was. */
const update = (book: ContainerBook, step: (held: Recorded) => Recorded): ContainerBook =>
  book.container === null ? book : { container: step(book.container) };

export const noteWaitReturned = (book: ContainerBook, now: number): ContainerBook =>
  update(book, (held) => (held.waitAt === null ? { ...held, waitAt: now } : held));

export const noteAttachEnded = (book: ContainerBook, now: number): ContainerBook =>
  update(book, (held) => (held.attachAt === null ? { ...held, attachAt: now } : held));

/** The launcher closed the attach in both directions; it counts only before the wait returns. */
export const noteAttachClosed = (book: ContainerBook, now: number): ContainerBook =>
  update(book, (held) =>
    held.waitAt === null && held.closedAt === null ? { ...held, closedAt: now } : held,
  );

export const killAnswered = (book: ContainerBook, answer: KillAnswer): ContainerBook =>
  update(book, (held) => (answer === 'failed' ? held : { ...held, killed: true }));

/** When the proxy's own delete falls due. */
function deleteAt(held: Recorded): number {
  const latest = held.deadline + GRACE_MS;
  if (held.wall) return latest;
  const ends =
    held.waitAt !== null && held.attachAt !== null
      ? Math.max(held.waitAt, held.attachAt) + GRACE_MS
      : Number.POSITIVE_INFINITY;
  const closed = held.closedAt === null ? Number.POSITIVE_INFINITY : held.closedAt + GRACE_MS;
  return Math.min(ends, closed, latest);
}

export function containerDue(book: ContainerBook, now: number): { kill: boolean; delete: boolean } {
  const held = book.container;
  if (held === null) return { kill: false, delete: false };
  return {
    kill: now >= held.deadline && !held.killed && held.waitAt === null,
    delete: now >= deleteAt(held),
  };
}

export const deleteAnswered = (
  book: ContainerBook,
  answer: DeleteAnswer,
): { book: ContainerBook; sweep: boolean } =>
  answer === 'failed' ? { book, sweep: true } : { book: EMPTY_CONTAINERS, sweep: false };

export const writeContainerBook = (book: ContainerBook): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(book));

const KEYS = ['id', 'createdAt', 'deadline', 'wall', 'killed', 'waitAt', 'attachAt', 'closedAt'];
const isTime = (value: Json | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTimeOrNull = (value: Json | undefined): value is number | null =>
  value === null || isTime(value);

function readRecorded(value: Json | undefined): Recorded | null {
  if (!hasExactKeys(value, KEYS) || !isJsonObject(value)) return null;
  const { id, createdAt, deadline, wall, killed, waitAt, attachAt, closedAt } = value;
  const fits =
    typeof id === 'string' &&
    CONTAINER_ID.test(id) &&
    isTime(createdAt) &&
    isTime(deadline) &&
    deadline >= createdAt &&
    typeof wall === 'boolean' &&
    typeof killed === 'boolean' &&
    isTimeOrNull(waitAt) &&
    isTimeOrNull(attachAt) &&
    isTimeOrNull(closedAt);
  return fits ? { id, createdAt, deadline, wall, killed, waitAt, attachAt, closedAt } : null;
}

export function readContainerBook(bytes: Uint8Array): SandboxResult<{ book: ContainerBook }> {
  const read = parseStrictJson(bytes);
  return read.ok ? containerBookOf(read.value) : fault('container record');
}

/** The book a parsed record holds, read as `readContainerBook` reads its bytes. */
export function containerBookOf(value: Json): SandboxResult<{ book: ContainerBook }> {
  if (!hasExactKeys(value, ['container']) || !isJsonObject(value)) return fault('container record');
  const held = value['container'];
  if (held === null) return { ok: true, book: EMPTY_CONTAINERS };
  const container = readRecorded(held);
  return container === null ? fault('container record') : { ok: true, book: { container } };
}
