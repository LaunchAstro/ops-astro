// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch from the task: under the agent holding the task, a Launch button
// that sends `task.launch`, or the open run's state once it is launched.
// Assigning started nothing; this click does. A client's task says why it
// cannot go to an AI agent instead of offering a click that is refused. A
// refusal shows its own words. One operation id per click, reused if the
// answer was lost and the person tries again, so a retry never opens a
// second run.

import { useRef, useState, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { isRefusal, isUnavailable } from '../../operations/results.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';

export interface LaunchRunProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly busy: boolean;
  readonly onChanged: () => void;
}

/** The click's state: in flight, the words of a refusal, and the send itself. */
function useLaunch(props: LaunchRunProps): {
  readonly sending: boolean;
  readonly words: string | null;
  readonly launch: () => Promise<void>;
} {
  const { task } = props;
  const [sending, setSending] = useState(false);
  const [words, setWords] = useState<string | null>(null);
  const operation = useRef<{ readonly taskId: string; readonly id: string } | null>(null);
  const launch = async (): Promise<void> => {
    if (operation.current?.taskId !== task.id) {
      operation.current = { taskId: task.id, id: props.client.newOperationId() };
    }
    setSending(true);
    setWords(null);
    const answer = await props.client.mutate(
      'task.launch',
      { recordId: task.id },
      { expectedRevision: task.revision, operationId: operation.current.id },
    );
    setSending(false);
    if (isUnavailable(answer)) {
      setWords(answer.because);
      return;
    }
    operation.current = null;
    if (isRefusal(answer)) setWords(answer.fixes.join(' '));
    else props.onChanged();
  };
  return { sending, words, launch };
}

export function LaunchRun(props: LaunchRunProps): ReactElement | null {
  const { task } = props;
  const { sending, words, launch } = useLaunch(props);
  const held = task.agent;
  if (held === null) return null;
  if (held.run !== null) {
    return (
      <p className="card__sub" data-run-state={held.run.state}>
        {held.run.state === 'waiting' ? 'Run waiting for the runner' : 'Run in progress'}
      </p>
    );
  }
  if (task.client !== null) {
    return <p className="card__sub">Only internal tasks go to an AI agent for now.</p>;
  }
  return (
    <>
      <button
        type="button"
        className="btn"
        data-launch-run
        disabled={props.busy || sending}
        onClick={() => void launch()}
      >
        {sending ? 'Launching…' : `Launch ${held.name}`}
      </button>
      {words === null ? null : (
        <p className="card__sub" role="alert">
          {words}
        </p>
      )}
    </>
  );
}
