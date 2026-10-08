// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Icon } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { useTaskPins, type TaskPins } from './task-pins.ts';

const PinsContext = createContext<TaskPins | null>(null);
export const useSharedTaskPins = (): TaskPins | null => useContext(PinsContext);

export function TaskPinsProvider(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly active: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return props.active ? (
    <OwnedPins {...props} />
  ) : (
    <PinsContext value={null}>{props.children}</PinsContext>
  );
}

function OwnedPins(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly children: ReactNode;
}): ReactElement {
  const pins = useTaskPins(props.client, props.grantKey);
  return <PinsContext value={pins}>{props.children}</PinsContext>;
}

export function TaskPin(props: { readonly taskId: string }): ReactElement | null {
  const pins = useSharedTaskPins();
  if (pins === null) return null;
  const on = pins.pinnedIds.includes(props.taskId);
  const label = on ? 'Unpin task' : 'Pin task';
  return (
    <button
      className="dtp__action"
      type="button"
      data-task-pin="panel"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={!pins.canToggle}
      onClick={() => {
        pins.toggle(props.taskId);
      }}
    >
      <Icon name="star" size="sm" />
    </button>
  );
}

export function TaskPinsNotice(): ReactElement | null {
  const pins = useSharedTaskPins();
  if (pins === null || pins.failure === null) return null;
  return (
    <p className="field__error" role="alert" data-task-pins-failure>
      {pins.failure.because}
      {pins.recovery === null ? null : (
        <button
          className="btn btn--sm"
          type="button"
          disabled={pins.saving || pins.loading}
          onClick={pins.recovery === 'read' ? pins.reload : pins.retry}
        >
          {pins.recovery === 'read' ? 'Read pins again' : 'Retry pin change'}
        </button>
      )}
    </p>
  );
}
