// SPDX-License-Identifier: AGPL-3.0-only
//
// Time tracking (MP-4-6, CS-4.1, CS-4.28 to CS-4.30): the five `time.*`
// commands over the time entry store (`core-records/src/tasks/time.ts`).
//
// The envelope has asked `time:write` of the business; start and log ask it
// again once the task's row is held. Each handler asks the rest here, before
// the store is touched:
//
// - **The task.** Start, stop and log name a task, and a person times only a
//   task they may read: `task:read` at that task's record scope. A task the
//   caller may not read is `NOT_FOUND`, the answer a task that is not here
//   gets, so a refusal never says whether it exists. The one exception is
//   the person's own running timer: stop reaches it after `task:read` is
//   lost, so a timer is never stuck running (ORCH57).
// - **The person.** The entry is the session's person's, always. A note or a
//   delete naming another person's entry is `NOT_FOUND` too: the store looks
//   an entry up by its id and its person together.
//
// None of the five names a subject record, so no time event is in the task's
// history or the activity ledger: those name each event's person and time, and
// another person's time is never sent (RS-VAULT-9). The client lock (S0-5,
// `task-client-lock.ts`) sees a time entry as the task's content by reading
// `time_entries` itself, a deleted entry included.
//
// Stop is the one stop-and-log step every closing surface calls (R77): it
// stops only this person's timer on the task it names, so closing one task's
// panel never stops a timer running against another.

import {
  checkAuthority,
  isUuid,
  deleteTimeEntry,
  logTime,
  parseDuration,
  setTimeEntryNote,
  startTimer,
  stopTimer,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { heldThenAskedAgain } from './prepare.ts';

type TimeContext = Pick<CommandContext, 'session'>;

const NO_TASK = refused(
  refuseCommand('NOT_FOUND', [], ['No live task carries that identifier here.']),
);
const NO_ENTRY = refused(
  refuseCommand('NOT_FOUND', [], ['None of your time entries carries that identifier.']),
);
/** A note is text, held to 0078's check (`time_entries_note_bounded`). */
const NOTE_LIMIT = 500;

const person = (context: TimeContext) => ({
  personId: context.session.personId,
  actorId: context.session.actorId,
});

/** `NOT_FOUND` unless the caller may read the task; the store then asks whether it is here. */
async function refuseUnreadable(
  tx: TenantQuery,
  context: TimeContext,
  taskId: string,
): Promise<Refused | undefined> {
  // Never cast what is not an identifier: it names no task, like a foreign one.
  if (!isUuid(taskId)) return NO_TASK;
  const reach = await checkAuthority(tx, subjectsOf(context.session), {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: taskId },
  });
  return reach.ok ? undefined : NO_TASK;
}

/**
 * Start and log hold the task's row before the store writes against it, so
 * `time:write` and `task:read` are asked once it is held: a grant that ran out
 * while this waited for the row refuses the write.
 */
async function heldAndReadable(
  tx: TenantQuery,
  context: CommandContext,
  taskId: string,
): Promise<Refused | undefined> {
  const lost = await heldThenAskedAgain(tx, context, taskId);
  return lost ?? (await refuseUnreadable(tx, context, taskId));
}

function noteOf(note: unknown): string | Refused {
  if (note === undefined) return '';
  if (typeof note === 'string' && note.length <= NOTE_LIMIT) return note;
  return refused(
    refuseCommand(
      'FIELD_VALUE_INVALID',
      ['note'],
      [`Send note as text of at most ${NOTE_LIMIT} characters.`],
    ),
  );
}

/** `time.start`: the person's one running timer, on this task. */
export async function startTime(
  tx: TenantQuery,
  context: CommandContext,
  taskId: string,
): Promise<HandlerOutcome> {
  const unreadable = await heldAndReadable(tx, context, taskId);
  if (unreadable !== undefined) return unreadable;
  const started = await startTimer(tx, { taskId, ...person(context) });
  if (started.kind === 'no-task') return NO_TASK;
  if (started.kind === 'running') {
    return refused(
      refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        ['timer'],
        ['Your timer is already running. Stop it, then start again.'],
      ),
    );
  }
  return applied(null, null, { entryId: started.entryId, startedAt: started.startedAt });
}

/** `time.stop`: stop the person's timer on this task and log its minutes (R77). */
export async function stopTime(
  tx: TenantQuery,
  context: TimeContext,
  taskId: string,
): Promise<HandlerOutcome> {
  // A person's own running timer stops even on a task they can no longer read
  // (ORCH57): losing access does not end it, and the answer is the entry's
  // own fields, nothing of the task. Without one, the task is still not found.
  const unreadable = await refuseUnreadable(tx, context, taskId);
  const stopped = await stopTimer(tx, { taskId, ...person(context) });
  if (stopped.kind === 'none') {
    return (
      unreadable ??
      refused(refuseCommand('NOT_FOUND', ['timer'], ['No timer of yours is running on this task.']))
    );
  }
  return applied(null, null, { entryId: stopped.entryId, minutes: stopped.minutes });
}

/** `time.log`: a finished entry typed by hand, ending now. */
export async function logTimeEntry(
  tx: TenantQuery,
  context: CommandContext,
  taskId: string,
  duration: unknown,
  note: unknown,
): Promise<HandlerOutcome> {
  const minutes = typeof duration === 'string' ? parseDuration(duration) : undefined;
  if (minutes === undefined) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['duration'],
        ['Send duration as "1h 30m", "90m" or "90", at least a minute and at most a day.'],
      ),
    );
  }
  const text = noteOf(note);
  if (typeof text !== 'string') return text;
  const unreadable = await heldAndReadable(tx, context, taskId);
  if (unreadable !== undefined) return unreadable;
  const logged = await logTime(tx, { taskId, ...person(context), minutes, note: text });
  if (logged.kind === 'no-task') return NO_TASK;
  return applied(null, null, { entryId: logged.entryId, minutes });
}

/** `time.set_note`: the note on one of the person's own entries. */
export async function setEntryNote(
  tx: TenantQuery,
  context: TimeContext,
  entryId: string,
  note: unknown,
): Promise<HandlerOutcome> {
  const text = noteOf(note ?? null);
  if (typeof text !== 'string') return text;
  const changed = await setTimeEntryNote(tx, { entryId, ...person(context), note: text });
  return changed ? applied(null, null, { entryId }) : NO_ENTRY;
}

/** `time.delete`: one of the person's own finished entries. */
export async function deleteEntry(
  tx: TenantQuery,
  context: TimeContext,
  entryId: string,
): Promise<HandlerOutcome> {
  const deleted = await deleteTimeEntry(tx, { entryId, ...person(context) });
  if (deleted === 'absent') return NO_ENTRY;
  if (deleted === 'running') {
    return refused(
      refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        ['timer'],
        ['That entry is still running. Stop the timer, then delete the entry.'],
      ),
    );
  }
  return applied(null, null, { entryId });
}
