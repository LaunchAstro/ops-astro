// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): banners, meters, figures, the one empty
// state, loading and error, the sample-data mark and the locate flash, in
// catalogue order.

import { Button } from './controls.tsx';
import { Empty } from '../primitives/Absence.tsx';
import { Banner, Kpi, Meter, MockRegion, RowNote, Skeleton } from './blocks.tsx';
import type { GalleryEntry } from './gallery-entry.ts';
import { TextFieldDemo, FlashDemo } from './gallery-demos.tsx';

export const FEEDBACK: readonly GalleryEntry[] = [
  {
    id: 'DS-PRIM-22',
    name: 'Banner and tip',
    interactive: true,
    states: [
      {
        label: 'Warning',
        render: () => <Banner lead="Heads up.">The retainer is 90% used.</Banner>,
      },
      {
        label: 'Failure',
        render: () => (
          <Banner tone="bad" lead="Not saved.">
            The server did not answer. Try again.
          </Banner>
        ),
      },
      {
        label: 'Info',
        render: () => <Banner tone="info">Figures are to the end of yesterday.</Banner>,
      },
      {
        label: 'Tip',
        render: () => (
          <Banner tone="info" onDismiss={() => {}}>
            Drag a card to change its stage.
          </Banner>
        ),
      },
      {
        label: 'Hint',
        render: () => (
          <Banner
            tone="hint"
            action={
              <Button variant="ghost" onClick={() => {}}>
                Set reminders
              </Button>
            }
          >
            The client must re-consent every 12 months. Two are overdue.
          </Banner>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-23',
    name: 'Meter and progress',
    interactive: false,
    states: [
      {
        label: 'Default with target',
        render: () => <Meter label="Hours used" value={12} max={20} target={16} />,
      },
      {
        label: 'Warning',
        render: () => <Meter label="Hours used" value={18} max={20} tone="warn" />,
      },
      {
        label: 'Stat track',
        render: () => <Meter label="Tasks done" value={9} max={14} look="stat" />,
      },
      {
        label: 'Time, over',
        render: () => <Meter label="Time logged" value={5} max={4} look="time" over />,
      },
    ],
  },
  {
    id: 'DS-PRIM-24',
    name: 'KPI number',
    interactive: false,
    states: [
      { label: 'Default', render: () => <Kpi label="Open tasks" value="8" /> },
      {
        label: 'Explained, of, track',
        render: () => (
          <Kpi
            label="Done"
            explain="Tasks closed this month"
            value="9"
            of="14"
            track={{ value: 9, max: 14 }}
          />
        ),
      },
      {
        label: 'With change',
        render: () => <Kpi label="Enquiries" value="31" delta="Up 4 on last month" />,
      },
    ],
  },
  {
    id: 'DS-PRIM-28',
    name: 'Empty state',
    interactive: false,
    states: [
      {
        label: 'Block',
        render: () => (
          <Empty title="No tasks on this board yet." action={<Button>New task</Button>} />
        ),
      },
      {
        label: 'Inline',
        render: () => <Empty look="inline" title="Nothing has been said about this one yet." />,
      },
      { label: 'Row', render: () => <Empty look="row" title="Nothing to act on" /> },
      {
        label: 'Filtered',
        render: () => <Empty title="No matches for these filters." onClearFilters={() => {}} />,
      },
    ],
  },
  {
    id: 'DS-PRIM-29',
    name: 'Loading state',
    interactive: false,
    states: [
      { label: 'Busy button', render: () => <Button busy="Saving…">Save</Button> },
      { label: 'Field placeholder', render: () => <Skeleton shape="field" /> },
      {
        label: 'Line and tile',
        render: () => (
          <span className="gallery__stack">
            <Skeleton shape="line" />
            <Skeleton shape="tile" />
          </span>
        ),
      },
      { label: 'Panel line', render: () => <Empty look="inline" title="Loading…" /> },
    ],
  },
  {
    id: 'DS-PRIM-30',
    name: 'Error state',
    interactive: false,
    states: [
      {
        label: 'Section error',
        render: () => <Banner tone="bad">The invoices could not be read.</Banner>,
      },
      { label: 'Row note', render: () => <RowNote>The last send bounced.</RowNote> },
      {
        label: 'Over the limit',
        render: () => <Meter label="Time logged" value={5} max={4} look="time" over />,
      },
      {
        label: 'Field error',
        render: () => <TextFieldDemo error="A title needs at least three words" />,
      },
    ],
  },
  {
    id: 'DS-PRIM-32',
    name: 'Mock-data mark',
    interactive: false,
    states: [
      {
        label: 'Region',
        render: () => (
          <MockRegion word>
            <Kpi label="Enquiries" value="31" />
          </MockRegion>
        ),
      },
      {
        label: 'Nested',
        render: () => (
          <MockRegion>
            <MockRegion nested>
              <Kpi label="Calls" value="12" />
            </MockRegion>
          </MockRegion>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-33',
    name: 'Locate flash',
    interactive: true,
    states: [{ label: 'Press to run once', render: () => <FlashDemo /> }],
  },
];
