// SPDX-License-Identifier: AGPL-3.0-only
import { useRereadOn } from './reread-on.ts';
import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { TaskTimerSelection } from './task-timer-selection.tsx';
import type { OperationsClient } from '../../operations/client.ts';
import { tabOwnerGeneration } from '../../session/token.ts';
import { TaskTimer, type TimerTask } from './task-timer.ts';

const Context = createContext<TaskTimer | null>(null);
export const useTaskTimer = (): TaskTimer | null => useContext(Context);

export function TaskTimerProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly active?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const tab = tabOwnerGeneration();
  const latest = useRef<object | null>(null);
  const owner = useMemo(() => ({ active: true }), [props.grantKey, tab]);
  latest.current = props.active === false ? null : owner;
  const timer = useMemo(
    () => new TaskTimer(props.client, () => owner.active && latest.current === owner),
    [owner],
  );
  timer.rebind(props.client);
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  return (
    <Context.Provider value={props.active === false ? null : timer}>
      {props.children}
    </Context.Provider>
  );
}

/** Standalone screens share the same owner too; App provides the lasting instance. */
export function TaskTimerBoundary(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly children: ReactNode;
}): ReactElement {
  const timer = useTaskTimer();
  return timer === null ? <TaskTimerProvider {...props} /> : <>{props.children}</>;
}

export function timerScreen(
  owner: { readonly client: OperationsClient; readonly grantKey: string; readonly taskKey: string },
  children: ReactNode,
): ReactElement {
  return (
    <TaskTimerBoundary {...owner}>
      <Fragment key={`${owner.grantKey}\u0000${owner.taskKey}`}>{children}</Fragment>
    </TaskTimerBoundary>
  );
}

export function timerFrame(
  owner: { readonly client: OperationsClient; readonly grantKey: string },
  active: boolean,
  select: (() => void) | null,
  children: ReactNode,
): ReactElement {
  return (
    <TaskTimerProvider {...owner} active={active}>
      <TaskTimerSelection.Provider value={select}>{children}</TaskTimerSelection.Provider>
    </TaskTimerProvider>
  );
}

export function useTimerState() {
  const timer = useTaskTimer();
  const empty = useMemo(
    () => ({ binding: null, attempt: null, changed: 0, unavailable: false }),
    [],
  );
  const state = useSyncExternalStore(
    timer?.subscribe ?? (() => () => {}),
    timer?.snapshot ?? (() => empty),
  );
  return { timer, state };
}

export function useTimerRead(client: OperationsClient, key: string) {
  const { timer, state } = useTimerState();
  const latest = useRef<object | null>(null);
  const reader = useMemo(() => ({ active: true }), [client, key, timer]);
  latest.current = reader;
  useEffect(() => {
    reader.active = true;
    return () => {
      reader.active = false;
    };
  }, [reader]);
  const run = () =>
    timer === null
      ? client.read<import('../../../../../packages/core-wire/src/index.ts').TaskReadResult>(
          'task.read',
          { recordId: key },
        )
      : timer.read(key, () => reader.active && latest.current === reader);
  return { run, changed: state.changed };
}

export function TaskTimerButton(props: {
  readonly task: TimerTask;
  readonly busy: boolean;
}): ReactElement {
  const { timer, state } = useTimerState();
  const running = state.binding?.task.id === props.task.id;
  const blocked = timer === null || state.attempt !== null || (state.binding !== null && !running);
  return (
    <button
      className="btn"
      type="button"
      data-timer
      data-running={running}
      aria-pressed={running}
      disabled={props.busy || blocked}
      onClick={() => (running ? timer?.stop(props.task.id) : timer?.start(props.task))}
    >
      {running ? '■ Stop' : 'Start timer'}
    </button>
  );
}

function Elapsed(props: { readonly startedAt: string }): ReactElement {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
    };
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(props.startedAt)) / 1000));
  return (
    <span data-task-timer-elapsed data-started-at={props.startedAt}>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

export function TaskTimerStrip(props: { readonly onSelect: () => void }): ReactElement {
  const { timer, state } = useTimerState();
  const binding = state.binding;
  return (
    <div data-task-timer-strip>
      <button
        className="appbar__timer"
        type="button"
        data-timer
        data-running={binding !== null}
        disabled={timer === null || state.attempt !== null}
        onClick={() => (binding === null ? props.onSelect() : timer?.stop())}
      >
        {binding === null
          ? 'Select task to time'
          : `■ Stop · ${binding.task.title ?? binding.task.key ?? 'Task unavailable'}`}
      </button>
      {binding?.running === null || binding === null ? null : (
        <Elapsed startedAt={binding.running.startedAt} />
      )}
      {state.unavailable ? (
        <span role="status">
          Task time could not be refreshed. Stop still files your known timer.
        </span>
      ) : null}
      <TaskTimerNotice />
    </div>
  );
}

export function TaskTimerNotice(): ReactElement | null {
  const { timer, state } = useTimerState();
  const attempt = state.attempt;
  if (attempt === null) return null;
  return (
    <span role="status" data-task-timer-notice>
      {attempt.status === 'pending'
        ? 'Saving timer…'
        : `${attempt.status === 'unknown' ? 'Timer outcome unknown' : 'Timer change refused'}: ${attempt.because ?? ''}`}
      {attempt.status === 'pending' ? null : (
        <button className="btn" type="button" data-task-timer-retry onClick={() => timer?.retry()}>
          Retry
        </button>
      )}
      {attempt.status === 'refused' ? (
        <button className="btn" type="button" onClick={() => timer?.dismiss()}>
          Dismiss refusal
        </button>
      ) : null}
    </span>
  );
}

/** Keep page inputs mounted only through a timer-triggered reread of the same task. */
export function useTimerRefresh(changed: number, outcome: string, reload: () => void): boolean {
  const refreshing = useRef(false);
  useRereadOn(changed, () => {
    refreshing.current = true;
    reload();
  });
  if (outcome !== 'loading') refreshing.current = false;
  return refreshing.current;
}
