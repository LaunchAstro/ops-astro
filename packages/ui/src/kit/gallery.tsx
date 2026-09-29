// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): every piece of the kit, once, in each of its
// drawn states, keyed by its catalogue id. The gallery test compares these ids
// with the catalogue's list, so a primitive that is built but not shown, or
// catalogued but not built, fails.
//
// A state here is one the markup draws (disabled, pressed, checked, open, an
// error). Hover and keyboard focus are real pointer and keyboard states; the
// width-and-theme harness (MP-1-7) drives them on the entries marked
// `interactive` rather than the gallery faking them with extra rules.
//
// It draws sample words only, never a record.

import { useState, type ReactElement } from 'react';
import {
  Button,
  Checkbox,
  Disclosure,
  HeadButton,
  IconButton,
  SearchBox,
  Segmented,
  Select,
  Switch,
  TextField,
} from './controls.tsx';

export interface GalleryState {
  readonly label: string;
  readonly render: () => ReactElement;
}

export interface GalleryEntry {
  readonly id: `DS-PRIM-${number}` | `DS-COMP-${number}` | `DOCK-D26`;
  readonly name: string;
  /** Whether the harness hovers and focuses it. */
  readonly interactive: boolean;
  readonly states: readonly GalleryState[];
}

const PEOPLE = [
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'lead', label: 'Account lead' },
  { value: 'designer', label: 'Designer' },
] as const;

function TextFieldDemo(props: {
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

function SelectDemo(props: { readonly open?: boolean; readonly disabled?: boolean }): ReactElement {
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

function SearchDemo(): ReactElement {
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

function CheckboxDemo(props: { readonly checked: boolean }): ReactElement {
  const [checked, setChecked] = useState(props.checked);
  return <Checkbox label="Done" checked={checked} onChange={setChecked} />;
}

function SwitchDemo(props: { readonly on: boolean; readonly disabled?: boolean }): ReactElement {
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

function SegmentedDemo(props: { readonly look: 'segmented' | 'facet' }): ReactElement {
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

function DisclosureDemo(props: { readonly open: boolean }): ReactElement {
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

export const GALLERY: readonly GalleryEntry[] = [
  {
    id: 'DS-PRIM-1',
    name: 'Button',
    interactive: true,
    states: [
      { label: 'Primary', render: () => <Button variant="primary">Save task</Button> },
      { label: 'Secondary', render: () => <Button>Cancel</Button> },
      { label: 'Ghost', render: () => <Button variant="ghost">More</Button> },
      { label: 'Text', render: () => <Button variant="text">Dismiss</Button> },
      { label: 'With icon', render: () => <Button icon="plus">New task</Button> },
      { label: 'Medium', render: () => <Button size="md">Add</Button> },
      {
        label: 'Large',
        render: () => (
          <Button variant="primary" size="lg">
            Book a call
          </Button>
        ),
      },
      { label: 'Pressed', render: () => <Button pressed>Mine</Button> },
      { label: 'Busy', render: () => <Button busy="Saving…">Save</Button> },
      {
        label: 'Primary disabled',
        render: () => (
          <Button variant="primary" disabled reason="Payments are not built yet">
            Pay now
          </Button>
        ),
      },
      { label: 'Secondary disabled', render: () => <Button disabled>Cancel</Button> },
    ],
  },
  {
    id: 'DS-PRIM-2',
    name: 'Icon button',
    interactive: true,
    states: [
      { label: 'Default', render: () => <IconButton icon="cross-small" label="Close" /> },
      { label: 'Compact', render: () => <IconButton icon="pencil" label="Edit" size="compact" /> },
      {
        label: 'Ask the agent',
        render: () => <IconButton icon="sparkles" label="Ask the agent" tone="accent" />,
      },
      {
        label: 'Remove',
        render: () => <IconButton icon="cross-small" label="Remove" tone="danger" />,
      },
      {
        label: 'Revealed on row hover',
        render: () => <IconButton icon="pencil" label="Edit" reveal />,
      },
      {
        label: 'Disabled',
        render: () => (
          <IconButton
            icon="download"
            label="Download"
            disabled
            reason="Downloads are not built yet"
          />
        ),
      },
    ],
  },
  {
    id: 'DOCK-D26',
    name: 'Dock head button',
    interactive: true,
    states: [
      { label: 'Close', render: () => <HeadButton kind="close" /> },
      { label: 'Back', render: () => <HeadButton kind="back" /> },
      { label: 'Forward, nothing ahead', render: () => <HeadButton kind="forward" disabled /> },
      { label: 'New', render: () => <HeadButton kind="new" label="New task" /> },
      { label: 'Close all', render: () => <HeadButton kind="close-all" /> },
    ],
  },
  {
    id: 'DS-PRIM-3',
    name: 'Text input',
    interactive: true,
    states: [
      { label: 'Default', render: () => <TextFieldDemo /> },
      {
        label: 'Error',
        render: () => <TextFieldDemo error="A title needs at least three words" />,
      },
      { label: 'Disabled', render: () => <TextFieldDemo disabled /> },
    ],
  },
  {
    id: 'DS-PRIM-4',
    name: 'Textarea',
    interactive: true,
    states: [{ label: 'Default', render: () => <TextFieldDemo multiline /> }],
  },
  {
    id: 'DS-PRIM-5',
    name: 'Select',
    interactive: true,
    states: [
      { label: 'Closed', render: () => <SelectDemo /> },
      { label: 'Open', render: () => <SelectDemo open /> },
      { label: 'Disabled', render: () => <SelectDemo disabled /> },
    ],
  },
  {
    id: 'DS-PRIM-6',
    name: 'Search box and keycap',
    interactive: true,
    states: [{ label: 'Default', render: () => <SearchDemo /> }],
  },
  {
    id: 'DS-PRIM-7',
    name: 'Checkbox',
    interactive: true,
    states: [
      { label: 'Unchecked', render: () => <CheckboxDemo checked={false} /> },
      { label: 'Checked', render: () => <CheckboxDemo checked /> },
    ],
  },
  {
    id: 'DS-PRIM-9',
    name: 'Switch',
    interactive: true,
    states: [
      { label: 'Off', render: () => <SwitchDemo on={false} /> },
      { label: 'On', render: () => <SwitchDemo on /> },
      { label: 'Disabled', render: () => <SwitchDemo on={false} disabled /> },
    ],
  },
  {
    id: 'DS-PRIM-10',
    name: 'Segmented control and facet',
    interactive: true,
    states: [
      { label: 'Segmented', render: () => <SegmentedDemo look="segmented" /> },
      { label: 'Facet', render: () => <SegmentedDemo look="facet" /> },
    ],
  },
  {
    id: 'DS-PRIM-31',
    name: 'Disclosure chevron',
    interactive: true,
    states: [
      { label: 'Closed', render: () => <DisclosureDemo open={false} /> },
      { label: 'Open', render: () => <DisclosureDemo open /> },
    ],
  },
];

/** The gallery page. */
export function Gallery(): ReactElement {
  return (
    <div className="gallery">
      <h1 className="gallery__title">Component gallery</h1>
      {GALLERY.map((entry) => (
        <section
          key={entry.id}
          className="gallery__entry"
          data-catalogue-id={entry.id}
          aria-labelledby={`g-${entry.id}`}
        >
          <h2 className="gallery__name" id={`g-${entry.id}`}>
            {entry.name} <span className="stamp">{entry.id}</span>
          </h2>
          <div className="gallery__states">
            {entry.states.map((state) => (
              <figure key={state.label} className="gallery__state" data-state={state.label}>
                <figcaption className="stamp">{state.label}</figcaption>
                {state.render()}
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
