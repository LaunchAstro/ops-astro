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
  readonly payload: Readonly<{ taskId: string }>;
  readonly operationId: string;
  readonly status: 'pending' | 'unknown' | 'refused';
  readonly because: string | null;
  readonly uncertain: boolean;
  readonly entryId: string | null;
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
  private readonly readFloors = new Map<string, number>();
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
    this.begin('time.stop', binding.task);
  };
  readonly retry = (): void => {
    const attempt = this.state.attempt;
    if (!this.ownerOn() || attempt === null || attempt.status === 'pending') return;
    this.dispatch({ ...attempt, status: 'pending', because: null });
  };
  readonly dismiss = (): void => {
    if (this.state.attempt?.status === 'refused') this.put({ ...this.state, attempt: null });
  };
  private begin(command: Attempt['command'], task: TimerTask): void {
    this.version += 1;
    this.dispatch({
      command,
      task: Object.freeze({ ...task }),
      payload: Object.freeze({ taskId: task.id }),
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
  async read(key: string, current: () => boolean): Promise<CallResult<TaskReadResult>> {
    const version = this.version;
    const ticket = ++this.readVersion;
    const known = [this.state.binding?.task, this.state.attempt?.task].find(
      (task) => task?.id === key || task?.key === key,
    );
    const keys = known === undefined ? [key] : [key, known.id, known.key ?? known.id];
    for (const identity of keys) this.readFloors.set(identity, ticket);
    const result = await this.client.read<TaskReadResult>('task.read', { recordId: key });
    // A page key and panel UUID share authority when the answer identifies the task.
    if ('ok' in result && 'task' in result.value)
      keys.push(result.value.task.id, result.value.task.key);
    const latest = keys.every((identity) => (this.readFloors.get(identity) ?? ticket) <= ticket);
    // The caller owns a projection too: an older read cannot publish revoked labels.
    if (!latest) return { unavailable: true, because: 'A newer task read superseded this answer.' };
    if (this.ownerOn() && current() && version === this.version && latest)
      this.observe(key, result);
    return result;
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
