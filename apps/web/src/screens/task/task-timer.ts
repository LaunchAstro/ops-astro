// SPDX-License-Identifier: AGPL-3.0-only
import type { TaskReadResult, TaskTimeView } from '../../../../../packages/core-wire/src/index.ts';
import type { CallResult, CommandOutcome, OperationsClient } from '../../operations/client.ts';
import { settle, type Settlement } from '../../records/use-command.ts';

export interface TimerTask {
  readonly id: string;
  readonly key?: string;
  readonly title?: string | null;
}
export interface TimerBinding {
  readonly task: TimerTask;
  readonly running: TaskTimeView['running'];
}
export type TimerHold = Pick<TimerState, 'binding' | 'attempt'>;
export type TimerDurability = 'none' | 'kept' | 'memory-only';
export interface TimerCustody {
  readonly restored: TimerHold | null;
  readonly write: (hold: TimerHold) => TimerDurability;
}
interface Attempt {
  readonly command: 'time.start' | 'time.stop';
  readonly task: TimerTask;
  readonly payload: Readonly<{ taskId: string; expectedEntryId?: string }>;
  readonly operationId: string;
  readonly status: 'pending' | 'unknown' | 'refused';
  readonly because: string | null;
  readonly uncertain: boolean;
  readonly entryId: string | null;
}
interface ReadFlight {
  readonly ticket: number;
  readonly keys: Set<string>;
  answer: Promise<CallResult<TaskReadResult>> | null;
}
export interface TimerState {
  readonly binding: TimerBinding | null;
  readonly attempt: Attempt | null;
  readonly changed: number;
  readonly unavailable: boolean;
  readonly durability: TimerDurability;
}
const initial = (): TimerState => ({
  binding: null,
  attempt: null,
  changed: 0,
  unavailable: false,
  durability: 'none',
});

/** One owner's known clock and one exact write envelope; reads cannot settle a lost write. */
export class TaskTimer {
  private state: TimerState = initial();
  private version = 0;
  private dispatchVersion = 0;
  private readVersion = 0;
  private readonly readers = new Set<Set<string>>();
  private readonly readFloors = new Map<string, ReadFlight>();
  private readonly listeners = new Set<() => void>();
  private client: OperationsClient;
  private readonly ownerOn: () => boolean;
  private readonly custody: TimerCustody | undefined;
  constructor(client: OperationsClient, ownerOn: () => boolean, custody?: TimerCustody) {
    this.client = client;
    this.ownerOn = ownerOn;
    this.custody = custody;
    if (custody?.restored !== null && custody?.restored !== undefined)
      this.state = { ...initial(), ...custody.restored, unavailable: true };
    if (this.ownerOn()) this.state = this.keep(this.state);
  }
  private keep(next: TimerState): TimerState {
    const durability =
      this.custody?.write(next) ??
      (next.binding === null && next.attempt === null ? 'none' : 'memory-only');
    return { ...next, durability };
  }
  /** Same owner, new admitted bearer. Old transport replies have no authority here. */
  rebind(client: OperationsClient): void {
    if (!this.ownerOn() || this.client === client) return;
    this.client = client;
    this.version += 1;
    const attempt = this.state.attempt;
    if (attempt?.status === 'pending')
      this.state = this.keep({
        ...this.state,
        attempt: {
          ...attempt,
          status: 'unknown',
          uncertain: true,
          because: 'The sign-in changed before the timer answer arrived.',
        },
      });
  }
  readonly snapshot = (): TimerState => this.state;
  readonly subscribe = (notify: () => void): (() => void) => {
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
    };
  };
  private put(next: TimerState): void {
    if (!this.ownerOn()) return;
    this.state = this.keep(next);
    for (const notify of this.listeners) notify();
  }
  readonly start = (task: TimerTask): void => {
    if (!this.ownerOn() || this.state.attempt !== null || this.state.binding !== null) return;
    this.begin('time.start', task);
  };
  readonly stop = (taskId?: string): void => {
    const binding = this.state.binding;
    if (!this.ownerOn() || this.state.attempt !== null || binding === null) return;
    if (taskId !== undefined && taskId !== binding.task.id) return;
    if (binding.running === null) return;
    this.begin('time.stop', binding.task, binding.running.entryId);
  };
  readonly retry = (): void => {
    const attempt = this.state.attempt;
    if (!this.ownerOn() || attempt === null || attempt.status === 'pending') return;
    this.dispatch({ ...attempt, status: 'pending', because: null });
  };
  readonly dismiss = (): void => {
    if (this.state.attempt?.status === 'refused') this.put({ ...this.state, attempt: null });
  };
  private begin(command: Attempt['command'], task: TimerTask, expectedEntryId?: string): void {
    this.version += 1;
    this.dispatch({
      command,
      task: Object.freeze({ ...task }),
      payload: Object.freeze(
        expectedEntryId === undefined ? { taskId: task.id } : { taskId: task.id, expectedEntryId },
      ),
      operationId: this.client.newOperationId(),
      status: 'pending',
      because: null,
      uncertain: false,
      entryId: this.state.binding?.running?.entryId ?? null,
    });
  }
  private dispatch(attempt: Attempt): void {
    this.put({ ...this.state, attempt });
    this.dispatchVersion += 1;
    void this.answer(attempt, this.dispatchVersion);
  }
  private async answer(sent: Attempt, dispatchVersion: number): Promise<void> {
    const transport = this.client;
    const attempt = sent;
    let outcome: Settlement<CommandOutcome>;
    try {
      outcome = settle(
        await transport.mutate(attempt.command, attempt.payload, {
          operationId: attempt.operationId,
        }),
      );
    } catch (error) {
      outcome = {
        kind: 'unknown',
        because: error instanceof Error ? error.message : 'No answer came back.',
      };
    }
    if (!this.ownerOn() || transport !== this.client || this.dispatchVersion !== dispatchVersion)
      return;
    const current = this.state.attempt;
    if (current === null) return;
    if (outcome.kind !== 'ok') {
      this.put({
        ...this.state,
        attempt: {
          ...current,
          status: outcome.kind === 'unknown' || attempt.uncertain ? 'unknown' : 'refused',
          uncertain: attempt.uncertain || outcome.kind === 'unknown',
          because: outcome.because,
        },
      });
      return;
    }
    const detail = outcome.value.detail ?? {};
    const running =
      typeof detail['entryId'] === 'string' && typeof detail['startedAt'] === 'string'
        ? { entryId: detail['entryId'], startedAt: detail['startedAt'] }
        : null;
    this.version += 1;
    this.put({
      ...this.state,
      attempt: null,
      changed: this.state.changed + 1,
      binding: this.settledBinding(current, running),
    });
  }
  private settledBinding(attempt: Attempt, running: TaskTimeView['running']): TimerBinding | null {
    const binding = this.state.binding;
    if (attempt.command === 'time.stop') {
      return binding?.task.id === attempt.task.id &&
        (binding.running?.entryId ?? null) === attempt.entryId
        ? null
        : binding;
    }
    if (binding !== null && binding.running?.entryId !== running?.entryId) return binding;
    return { task: attempt.task, running };
  }
  /** Captured before transport: a pre-Start idle answer cannot erase a newer binding. */
  read(key: string, current: () => boolean): Promise<CallResult<TaskReadResult>> {
    const keys = new Set([key]);
    this.readers.add(keys);
    return this.readTask(key, current, keys).finally(() => {
      this.readers.delete(keys);
      for (const flight of this.readFloors.values())
        if (![...this.readers].some((reader) => [...flight.keys].some((id) => reader.has(id))))
          flight.answer = null;
    });
  }
  private async readTask(
    key: string,
    current: () => boolean,
    keys: Set<string>,
  ): Promise<CallResult<TaskReadResult>> {
    const version = this.version;
    const ticket = ++this.readVersion;
    const known = [this.state.binding?.task, this.state.attempt?.task].find(
      (task) => task?.id === key || task?.key === key,
    );
    if (known !== undefined) for (const id of [known.id, known.key ?? known.id]) keys.add(id);
    const latest: ReadFlight = {
      ticket,
      keys,
      answer: this.client.read<TaskReadResult>('task.read', { recordId: key }),
    };
    for (const identity of keys) this.readFloors.set(identity, latest);
    const result = await this.readLatest(keys, latest);
    if (!this.ownerOn() || !current() || version !== this.version)
      return {
        unavailable: true,
        because: 'The task read owner changed before its answer arrived.',
      };
    this.observe(key, result);
    return result;
  }
  /** Join a newer checked answer, including its denial or withheld projections; never re-request. */
  private async readLatest(
    keys: Set<string>,
    flight: ReadFlight,
  ): Promise<CallResult<TaskReadResult>> {
    if (flight.answer === null)
      return { unavailable: true, because: 'A newer task read superseded this answer.' };
    const result = await flight.answer;
    if ('ok' in result && 'task' in result.value)
      for (const id of [result.value.task.id, result.value.task.key]) {
        keys.add(id);
        flight.keys.add(id);
      }
    const newer = [...keys].reduce((latest, identity) => {
      const next = this.readFloors.get(identity);
      return next !== undefined && next.ticket > latest.ticket ? next : latest;
    }, flight);
    return newer === flight ? result : this.readLatest(keys, newer);
  }
  private observe(key: string, result: CallResult<TaskReadResult>): void {
    const binding = this.state.binding;
    const attempt = this.state.attempt;
    const matches = binding !== null && [binding.task.id, binding.task.key].includes(key);
    const attempted = attempt !== null && [attempt.task.id, attempt.task.key].includes(key);
    if ('ok' in result) {
      if (!('task' in result.value)) return;
      const task = result.value.task;
      if (task.time === null || task.time === undefined) {
        if (matches || attempted) this.put({ ...this.state, unavailable: true });
        return;
      }
      const running = task.time.running;
      if (running !== null) {
        this.put({
          ...this.state,
          binding: { task: { id: task.id, key: task.key, title: task.title }, running },
          unavailable: false,
        });
      } else if (binding?.task.id === task.id && this.state.attempt === null) {
        this.put({ ...this.state, binding: null, unavailable: false });
      }
      return;
    }
    if (!matches && !attempted) return;
    if ('refused' in result) {
      this.put({
        ...this.state,
        binding: matches ? { ...binding, task: { id: binding.task.id } } : binding,
        attempt: attempted ? { ...attempt, task: { id: attempt.task.id } } : attempt,
        unavailable: true,
      });
    } else this.put({ ...this.state, unavailable: true });
  }
}
