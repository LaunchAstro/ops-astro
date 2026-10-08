// SPDX-License-Identifier: AGPL-3.0-only
import { isUuid, isRecord, type StorageLike } from '../../session/storage-slot.ts';
import { taskTimerKey } from '../../session/token.ts';
import type { TimerBinding, TimerHold, TimerCustody } from './task-timer.ts';

function bindingFrom(value: unknown): TimerBinding | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isRecord(value['task']) || !isUuid(value['task']['id']))
    return undefined;
  const running = value['running'];
  if (running === null) return { task: { id: value['task']['id'] }, running: null };
  if (
    !isRecord(running) ||
    !isUuid(running['entryId']) ||
    typeof running['startedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(running['startedAt']))
  )
    return undefined;
  return {
    task: { id: value['task']['id'] },
    running: { entryId: running['entryId'], startedAt: running['startedAt'] },
  };
}

function attemptFrom(value: unknown): TimerHold['attempt'] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const command = value['command'];
  const status = value['status'];
  const payload = value['payload'];
  const operationId = value['operationId'];
  const entryId = value['entryId'];
  if (
    (command !== 'time.start' && command !== 'time.stop') ||
    (status !== 'pending' && status !== 'unknown' && status !== 'refused') ||
    !isRecord(payload) ||
    !isUuid(payload['taskId']) ||
    !isUuid(operationId) ||
    typeof value['uncertain'] !== 'boolean' ||
    (entryId !== null && !isUuid(entryId)) ||
    Object.keys(payload).some((key) => key !== 'taskId' && key !== 'expectedEntryId') ||
    (payload['expectedEntryId'] !== undefined &&
      (command !== 'time.stop' || !isUuid(payload['expectedEntryId'])))
  )
    return undefined;
  const knownRefusal = status === 'refused' && !value['uncertain'];
  return {
    command,
    task: { id: payload['taskId'] },
    // Keep an existing guard byte-for-byte; never fill one into a legacy unknown Stop.
    payload: Object.freeze({ ...payload, taskId: payload['taskId'] }),
    operationId,
    status: knownRefusal ? 'refused' : 'unknown',
    because: knownRefusal
      ? 'This timer operation was refused before reload. Retry checks the current permission.'
      : 'The previous timer answer was not retained. Retry the same operation.',
    uncertain: !knownRefusal,
    entryId,
  };
}

function holdFrom(value: unknown, owner: string): TimerHold | null {
  if (!isRecord(value) || value['version'] !== 1 || value['owner'] !== owner) return null;
  const binding = bindingFrom(value['binding']);
  const attempt = attemptFrom(value['attempt']);
  return binding === undefined || attempt === undefined ? null : { binding, attempt };
}

function stored(hold: TimerHold, owner: string) {
  const { binding, attempt } = hold;
  return {
    version: 1,
    owner,
    binding: binding === null ? null : { task: { id: binding.task.id }, running: binding.running },
    attempt:
      attempt === null
        ? null
        : {
            command: attempt.command,
            payload: { ...attempt.payload },
            operationId: attempt.operationId,
            status: attempt.status,
            uncertain: attempt.uncertain,
            entryId: attempt.entryId,
          },
  };
}

/** One validated tab pointer. It confers no permission and contains no task metadata. */
export function timerCustody(storage: StorageLike | null, owner: string): TimerCustody {
  let restored: TimerHold | null = null;
  try {
    const raw = storage?.getItem(taskTimerKey);
    if (raw !== undefined && raw !== null) restored = holdFrom(JSON.parse(raw), owner);
  } catch {
    // An unreadable copy grants nothing; write() reports whether custody can be kept.
  }
  return {
    restored,
    write: (hold) => {
      if (storage === null) return 'memory-only';
      try {
        if (hold.binding === null && hold.attempt === null) {
          storage.removeItem(taskTimerKey);
          return storage.getItem(taskTimerKey) === null ? 'none' : 'memory-only';
        }
        const raw = JSON.stringify(stored(hold, owner));
        storage.setItem(taskTimerKey, raw);
        return storage.getItem(taskTimerKey) === raw ? 'kept' : 'memory-only';
      } catch {
        return 'memory-only';
      }
    },
  };
}
