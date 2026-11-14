// SPDX-License-Identifier: AGPL-3.0-only
//
// #1719 (R10): after a run stops short of a finish, a person may ask for the
// work again. Restart sends `task.restart` for the stopped run's lineage,
// which starts a fresh attempt and leaves the stopped one as it was recorded;
// the server decides whether this person may (`decide` on the task), and a
// refusal is quoted in its words. A restart that lands asks the host to read
// the task and its runs again.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';

export function RunRestart(props: {
  readonly client: OperationsClient;
  readonly recordId: string;
  readonly lineageId: string;
  readonly onRestarted: () => void;
}): ReactElement {
  const { busy, locked, because, run } = useCommand();
  const restart = (): void => {
    run(
      () =>
        props.client.mutate('task.restart', {
          recordId: props.recordId,
          lineageId: props.lineageId,
        }),
      (settlement) => {
        if (settlement.kind === 'ok') props.onRestarted();
      },
    );
  };
  return (
    <>
      <button
        className="btn btn--sm btn--secondary"
        type="button"
        data-run-restart={props.lineageId}
        disabled={busy || locked}
        onClick={restart}
      >
        Restart
      </button>
      {because === null ? null : (
        <span className="field__error" role="alert" data-run-restart-refusal="">
          {because}
        </span>
      )}
    </>
  );
}
