// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): the controls, in catalogue order.

import { Button, HeadButton, IconButton } from './controls.tsx';
import type { GalleryEntry } from './gallery-entry.ts';
import {
  TextFieldDemo,
  SelectDemo,
  SearchDemo,
  CheckboxDemo,
  SwitchDemo,
  SegmentedDemo,
  DisclosureDemo,
} from './gallery-demos.tsx';

export const CONTROLS: readonly GalleryEntry[] = [
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
