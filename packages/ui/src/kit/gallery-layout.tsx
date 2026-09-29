// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): the table, the card and the composites,
// in catalogue order.

import { Button } from './controls.tsx';
import { Avatar, Chip, Marker } from './marks.tsx';
import { Icon } from '../primitives/Icon.tsx';
import { Card, DoorCard, FormLayout, ListRow, Table } from './blocks.tsx';
import type { GalleryEntry } from './gallery-entry.ts';
import { TextFieldDemo, SelectDemo, SAMPLE_ROWS } from './gallery-demos.tsx';

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
                onSort: () => {},
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
];
