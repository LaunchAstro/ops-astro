// SPDX-License-Identifier: AGPL-3.0-only
//
// The Ad hoc and Client access ticks (MP-4-10, DP-16, DP-17): the live ones,
// for the dock task panel (MP-4-8 mounts them). The task page's copies are
// inert (`Facts.tsx`).
//
// **Each tick goes out through the command that owns it.** Ad hoc through
// `task.set_adhoc` with the value it is turning to; Client access through
// `task.share_with_client` to turn on and `task.revoke_client_share` to turn
// off. Each is sent at the task's revision, and a success asks the page to
// read the task again: the tick then draws what the server holds, never a
// value of its own.
//
// **Pointer and keyboard, in place.** A tick is a checkbox a person can tab
// to; a press, Space or Enter turns it, and nothing on the page moves. It is
// a focusable element with the checkbox role rather than a native button, so
// there is exactly one activation path per key and no native click to double
// it.
//
// **One press at a time.** While a write is in flight both ticks say they are
// busy and ignore presses; a refusal is quoted and the ticks stay as the
// server has them.

import type { KeyboardEvent, ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';

export interface TicksTask {
  readonly id: string;
  readonly revision: number;
  readonly adHoc: boolean;
  readonly clientAccess: boolean;
}

type Tick = 'adhoc' | 'client-access';

function TickBox(props: {
  readonly name: Tick;
  readonly label: string;
  readonly on: boolean;
  readonly busy: boolean;
  readonly onTurn: () => void;
}): ReactElement {
  const press = (): void => {
    if (!props.busy) props.onTurn();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    press();
  };
  return (
    <span className="tpr__fact">
      <span className="tf__k">{props.label}</span>
      <span
        className="tpr__tick"
        role="checkbox"
        tabIndex={0}
        data-tick={props.name}
        aria-label={props.label}
        aria-checked={props.on}
        aria-disabled={props.busy}
        onClick={press}
        onKeyDown={onKeyDown}
      >
        {props.on ? '✓' : ''}
      </span>
    </span>
  );
}

export function HandlingTicks(props: {
  readonly client: OperationsClient;
  readonly task: TicksTask;
  readonly onChanged: () => void;
}): ReactElement {
  const { client, task } = props;
  const { busy, because, run } = useCommand();

  const after = (settlement: { readonly kind: string }): void => {
    if (settlement.kind === 'ok') props.onChanged();
  };
  const at = { expectedRevision: task.revision };
  const turnAdHoc = (): void => {
    run(
      () =>
        client.mutate('task.set_adhoc', { recordId: task.id, fields: { ad_hoc: !task.adHoc } }, at),
      after,
    );
  };
  const turnClientAccess = (): void => {
    const command = task.clientAccess ? 'task.revoke_client_share' : 'task.share_with_client';
    run(() => client.mutate(command, { recordId: task.id }, at), after);
  };

  return (
    <div className="tpr__strip">
      <TickBox name="adhoc" label="Ad hoc" on={task.adHoc} busy={busy} onTurn={turnAdHoc} />
      <TickBox
        name="client-access"
        label="Client access"
        on={task.clientAccess}
        busy={busy}
        onTurn={turnClientAccess}
      />
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}
