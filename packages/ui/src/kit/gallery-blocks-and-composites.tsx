// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): the blocks and composites, in catalogue order.

import { Button } from './controls.tsx';
import { Avatar, Chip, Marker } from './marks.tsx';
import { Icon } from '../primitives/Icon.tsx';
import { Empty } from '../primitives/Absence.tsx';
import {
  Banner,
  Card,
  DoorCard,
  FormLayout,
  Kpi,
  ListRow,
  Meter,
  MockRegion,
  RowNote,
  Skeleton,
  Table,
} from './blocks.tsx';
import type { GalleryEntry } from './gallery-entry.ts';
import { TextFieldDemo, SelectDemo, FlashDemo, SAMPLE_ROWS } from './gallery-demos.tsx';

export const BLOCKS: readonly GalleryEntry[] = [
  {
    id: 'DS-PRIM-20',
    name: 'Table and cells',
    interactive: true,
    states: [
      {
        label: 'Default, sorted by hours',
        render: () => (
          <Table
            caption="Hours by piece of work"
            columns={[
              { key: 'name', label: 'Work' },
              { key: 'owner', label: 'Owner' },
              {
                key: 'hours',
                label: 'Hours',
                align: 'end',
                sort: 'descending',
                onSort: () => undefined,
              },
            ]}
            rows={SAMPLE_ROWS}
            exportControl={
              <Button disabled reason="Export is not built yet">
                Export CSV
              </Button>
            }
          />
        ),
      },
      {
        label: 'Dense',
        render: () => (
          <Table
            caption="Hours by piece of work"
            dense
            columns={[
              { key: 'name', label: 'Work' },
              { key: 'hours', label: 'Hours', align: 'end' },
            ]}
            rows={SAMPLE_ROWS}
          />
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-21',
    name: 'Card (base)',
    interactive: false,
    states: [
      {
        label: 'Default',
        render: () => (
          <Card title="This week" sub="Three pieces due">
            Body text of the card.
          </Card>
        ),
      },
      {
        label: 'Flush',
        render: () => (
          <Card title="Recent" flush>
            <ul className="gallery__list">
              <ListRow title="Homepage copy" meta="Due Friday" />
            </ul>
          </Card>
        ),
      },
    ],
  },
  {
    id: 'DS-COMP-7',
    name: 'Card (content and list card)',
    interactive: false,
    states: [
      {
        label: 'With actions',
        render: () => (
          <Card title="Retainer" sub="September" actions={<Button>Open</Button>}>
            Twelve of twenty hours used.
          </Card>
        ),
      },
      {
        label: 'Current choice',
        render: () => (
          <Card title="Growth plan" sub="Your plan" current>
            Monthly, cancel any time.
          </Card>
        ),
      },
    ],
  },
  {
    id: 'DS-COMP-8',
    name: 'Door card',
    interactive: true,
    states: [
      {
        label: 'Card door',
        render: () => <DoorCard href="#gallery" title="Invoices" sub="Two waiting" />,
      },
      {
        label: 'Row door',
        render: () => <DoorCard href="#gallery" title="Booking page" sub="In review" look="row" />,
      },
      {
        label: 'Call to action',
        render: () => (
          <DoorCard href="#gallery" title="Finish setting up" sub="Two steps left" look="cta" />
        ),
      },
      {
        label: 'External',
        render: () => <DoorCard href="https://example.org" title="Search Console" external />,
      },
    ],
  },
  {
    id: 'DS-COMP-13',
    name: 'List row',
    interactive: true,
    states: [
      {
        label: 'Page rows',
        render: () => (
          <ul className="gallery__list">
            <ListRow
              lead={<Avatar name="Writer One" />}
              title="Homepage copy"
              meta="Due Friday"
              trail={<Chip>Draft</Chip>}
            />
            <ListRow title="Booking page" meta="Done" state="done" />
            <ListRow title="Old brief" meta="Archived" state="archived" />
            <ListRow
              lead={<Icon name="eye" />}
              title="Owner approves the budget"
              meta="Gate step"
              state="gate"
              trail={<Marker look="key">Needs sign-off</Marker>}
            />
          </ul>
        ),
      },
      {
        label: 'Panel, notice and record rows',
        render: () => (
          <ul className="gallery__list">
            <ListRow look="panel" title="Sample Clinic" meta="3 open" state="selected" />
            <ListRow look="notice" title="A comment mentions you" meta="2 min ago" />
            <ListRow look="record" title="Owner" meta="Account lead" />
          </ul>
        ),
      },
    ],
  },
  {
    id: 'DS-COMP-26',
    name: 'Form layout',
    interactive: true,
    states: [
      {
        label: 'Inline form',
        render: () => (
          <FormLayout
            label="New task"
            actions={
              <Button variant="primary" type="submit">
                Create
              </Button>
            }
          >
            <TextFieldDemo />
            <SelectDemo />
          </FormLayout>
        ),
      },
    ],
  },
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
          <Banner tone="info" onDismiss={() => undefined}>
            Drag a card to change its stage.
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
        render: () => (
          <Empty title="No matches for these filters." onClearFilters={() => undefined} />
        ),
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
