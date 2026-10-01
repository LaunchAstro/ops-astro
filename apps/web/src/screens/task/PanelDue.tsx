// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's due date (MP-4-8), one of `PanelFields.tsx`'s field
// edits: chosen in the picker and sent through `task.update` at the revision
// the picker opened at (review/305-pf-keep round 3), so a colleague's change
// since answers stale rather than being overwritten.

import { useState, type ReactElement } from 'react';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { DatePicker } from './DatePicker.tsx';
import { todayOn } from './due-dates.ts';

interface DueFieldProps {
  readonly task: Task;
  readonly busy: boolean;
  /** The panel's field write, at the revision given. */
  readonly write: (
    command: 'task.update',
    fields: Readonly<Record<string, unknown>>,
    revision: number,
  ) => void;
}

/**
 * The due date, chosen in the picker, sent at the revision the picker opened
 * at; choosing the day it already has sends nothing.
 */
export function DueField(props: DueFieldProps): ReactElement {
  const [picking, setPicking] = useState<number | null>(null);
  const due = props.task.due?.slice(0, 10) ?? null;
  const choose = (day: string | null): void => {
    setPicking(null);
    if (day !== due && picking !== null) props.write('task.update', { due: day }, picking);
  };
  return (
    <>
      <span className="tf__k">Due</span>
      <button
        className="btn"
        type="button"
        data-panel-field="due"
        aria-expanded={picking !== null}
        disabled={props.busy}
        onClick={() => setPicking(picking === null ? props.task.revision : null)}
      >
        {due ?? 'Not set'}
      </button>
      {picking === null ? null : (
        <DatePicker
          value={due}
          today={todayOn(new Date())}
          onChoose={choose}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
