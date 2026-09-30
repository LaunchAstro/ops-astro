// SPDX-License-Identifier: AGPL-3.0-only
//
// The due date picker (MP-4-8, CS-4.13, DS-PRIM-19): a month grid, Monday
// first, that chooses one day or none.
//
// **Browsing never chooses.** The month buttons and the arrow keys move the
// focused day (up and down a week, left and right a day, turning the month at
// its edge); only Enter, a click, a quick choice or Clear hands a day to
// `onChoose`.
//
// **Its Escape is its own.** Escape anywhere inside closes the picker and is
// marked handled, so the panel around it stays open (TR-A3-3).
//
// The component gallery entry and its captures wait on the kit (MP-1-3,
// MP-1-7).

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { addDays, addMonths, monthLabel, monthWeeks } from './due-dates.ts';

export interface DatePickerProps {
  /** The day chosen now, or none. */
  readonly value: string | null;
  /** The business's day, which the quick choices count from. */
  readonly today: string;
  readonly onChoose: (day: string | null) => void;
  readonly onClose: () => void;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const STEP: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

const QUICK = [
  ['today', 'Today', 0],
  ['week', 'In a week', 7],
  ['fortnight', 'In two weeks', 14],
] as const;

export function DatePicker(props: DatePickerProps): ReactElement {
  const [focus, setFocus] = useState(props.value ?? props.today);
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };
  return (
    <div
      className="dpk"
      role="dialog"
      aria-label="Choose a due date"
      data-date-picker
      onKeyDown={onKey}
    >
      <div className="dpk__head">
        <button
          className="btn btn--ghost"
          type="button"
          data-picker="prev"
          aria-label="Previous month"
          onClick={() => setFocus(addMonths(focus, -1))}
        >
          ‹
        </button>
        <span className="dpk__month" data-picker-month aria-live="polite">
          {monthLabel(focus)}
        </span>
        <button
          className="btn btn--ghost"
          type="button"
          data-picker="next"
          aria-label="Next month"
          onClick={() => setFocus(addMonths(focus, 1))}
        >
          ›
        </button>
      </div>
      <MonthGrid {...props} focus={focus} onFocus={setFocus} />
      <QuickChoices {...props} />
    </div>
  );
}

/** The month of the focused day; arrows move the focus, Enter or a click chooses. */
function MonthGrid(
  props: DatePickerProps & { readonly focus: string; readonly onFocus: (day: string) => void },
): ReactElement {
  const { focus } = props;
  const focused = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    focused.current?.focus();
  }, [focus]);
  const onKey = (event: KeyboardEvent<HTMLTableElement>): void => {
    const step = STEP[event.key];
    if (step !== undefined) {
      event.preventDefault();
      props.onFocus(addDays(focus, step));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      props.onChoose(focus);
    }
  };
  return (
    <table className="dpk__grid" role="grid" aria-label={monthLabel(focus)} onKeyDown={onKey}>
      <thead>
        <tr role="row">
          {WEEKDAYS.map((name) => (
            <th key={name} role="columnheader" scope="col">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {monthWeeks(focus).map((week) => (
          <tr key={week.find((day) => day !== null) ?? ''} role="row">
            {week.map((day, index) =>
              day === null ? (
                <td key={`blank-${String(index)}`} role="gridcell" />
              ) : (
                <DayCell key={day} {...props} day={day} focused={day === focus ? focused : null} />
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One day: the focused one takes the tab stop and the keyboard's focus. */
function DayCell(
  props: DatePickerProps & {
    readonly day: string;
    readonly focused: RefObject<HTMLTableCellElement | null> | null;
  },
): ReactElement {
  const { day } = props;
  return (
    <td
      ref={props.focused ?? undefined}
      role="gridcell"
      className="dpk__day"
      data-day={day}
      data-today={day === props.today}
      aria-selected={day === props.value}
      tabIndex={props.focused === null ? -1 : 0}
      onClick={() => props.onChoose(day)}
    >
      {Number(day.slice(8))}
    </td>
  );
}

/** Today, In a week and In two weeks, counted from the business's day, and Clear. */
function QuickChoices(props: DatePickerProps): ReactElement {
  return (
    <div className="btnrow">
      {QUICK.map(([name, label, days]) => (
        <button
          key={name}
          className="btn"
          type="button"
          data-picker-quick={name}
          onClick={() => props.onChoose(addDays(props.today, days))}
        >
          {label}
        </button>
      ))}
      <button
        className="btn btn--ghost"
        type="button"
        data-picker-quick="clear"
        onClick={() => props.onChoose(null)}
      >
        Clear
      </button>
    </div>
  );
}
