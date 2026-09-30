// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery's sample data and the small stateful demos its
// entries draw (MP-1-3). Sample words only, never a record.

import { useRef, useState, type ReactElement } from 'react';
import {
  Button,
  Checkbox,
  Disclosure,
  SearchBox,
  Segmented,
  Select,
  Switch,
  TextField,
} from './controls.tsx';
import { type MarkTone } from './marks.tsx';
import { locate } from './blocks.tsx';

export const PEOPLE = [
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'lead', label: 'Account lead' },
  { value: 'designer', label: 'Designer' },
] as const;

export function TextFieldDemo(props: {
  readonly error?: string;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
}): ReactElement {
  const [value, setValue] = useState(props.error === undefined ? '' : 'Too short');
  return (
    <TextField
      label={props.multiline === true ? 'Brief' : 'Task title'}
      value={value}
      onChange={setValue}
      placeholder={props.multiline === true ? 'What should happen' : 'Name the task'}
      hint="One line, in plain words"
      error={props.error}
      multiline={props.multiline}
      disabled={props.disabled}
    />
  );
}

export function SelectDemo(props: {
  readonly open?: boolean;
  readonly disabled?: boolean;
}): ReactElement {
  const [value, setValue] = useState<string>('lead');
  return (
    <Select
      label="Assignee"
      options={PEOPLE}
      value={value}
      onChange={setValue}
      defaultOpen={props.open}
      disabled={props.disabled}
    />
  );
}

export function SearchDemo(): ReactElement {
  const [value, setValue] = useState('');
  return (
    <SearchBox
      label="Search tasks"
      value={value}
      onChange={setValue}
      placeholder="Search"
      keycap="⌘K"
    />
  );
}

export function CheckboxDemo(props: { readonly checked: boolean }): ReactElement {
  const [checked, setChecked] = useState(props.checked);
  return <Checkbox label="Done" checked={checked} onChange={setChecked} />;
}

export function SwitchDemo(props: {
  readonly on: boolean;
  readonly disabled?: boolean;
}): ReactElement {
  const [on, setOn] = useState(props.on);
  return (
    <Switch
      label="Email me when a task is assigned"
      on={on}
      onChange={setOn}
      disabled={props.disabled}
      reason="Email notices are not built yet"
    />
  );
}

export function SegmentedDemo(props: { readonly look: 'segmented' | 'facet' }): ReactElement {
  const [value, setValue] = useState('open');
  return (
    <Segmented
      label="Show"
      look={props.look}
      value={value}
      onChange={setValue}
      options={[
        { value: 'open', label: 'Open', count: props.look === 'facet' ? 8 : undefined },
        { value: 'done', label: 'Done', count: props.look === 'facet' ? 3 : undefined },
        { value: 'all', label: 'All', count: props.look === 'facet' ? 11 : undefined },
      ]}
    />
  );
}

export function DisclosureDemo(props: { readonly open: boolean }): ReactElement {
  const [open, setOpen] = useState(props.open);
  const id = props.open ? 'gallery-disclosure-open' : 'gallery-disclosure-closed';
  return (
    <div>
      <Disclosure label="Show the detail" open={open} onToggle={setOpen} controls={id} />
      <p id={id} hidden={!open}>
        The detail this row was hiding.
      </p>
    </div>
  );
}

export const TONES: readonly MarkTone[] = ['ok', 'warn', 'bad', 'info', 'idle'];
export const TONE_WORDS: Readonly<Record<MarkTone, string>> = {
  ok: 'Done',
  warn: 'Due soon',
  bad: 'Overdue',
  info: 'Running',
  idle: 'Waiting',
};

export function FlashDemo(): ReactElement {
  const target = useRef<HTMLDivElement>(null);
  return (
    <div className="gallery__flash">
      <Button
        onClick={() => {
          if (target.current !== null) locate(target.current);
        }}
      >
        Show where the link lands
      </Button>
      <div ref={target} className="card">
        The linked comment
      </div>
    </div>
  );
}

export const MONTHS = ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const SAMPLE_ROWS = [
  { name: 'Homepage copy', owner: 'Writer', hours: '6.5' },
  { name: 'Booking page', owner: 'Designer', hours: '12.0' },
] as const;
