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

import { useRef, useState, type ReactElement } from 'react';
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
import {
  Avatar,
  AvatarStack,
  Chip,
  Count,
  Countdown,
  Divider,
  DoorMark,
  Index,
  Link,
  Marker,
  StatusLine,
  StatusMark,
  Term,
  type MarkTone,
} from './marks.tsx';
import { GLYPH_NAMES, Icon } from '../primitives/Icon.tsx';
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
  Popover,
  RowNote,
  Skeleton,
  Table,
  locate,
} from './blocks.tsx';
import { FreshnessMarker, NotConnected, SourceRegion, Unavailable } from './treatments.tsx';
import {
  ColumnChart,
  DonutChart,
  Funnel,
  Gauge,
  LineChart,
  ScoreDial,
  Sparkline,
} from './charts.tsx';

export interface GalleryState {
  readonly label: string;
  readonly render: () => ReactElement;
}

export interface GalleryEntry {
  /** A catalogue id, or the ticket for a treatment the catalogue has no single id for. */
  readonly id: `DS-PRIM-${number}` | `DS-COMP-${number}` | 'DOCK-D26' | 'MP-1-6';
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

const TONES: readonly MarkTone[] = ['ok', 'warn', 'bad', 'info', 'idle'];
const TONE_WORDS: Readonly<Record<MarkTone, string>> = {
  ok: 'Done',
  warn: 'Due soon',
  bad: 'Overdue',
  info: 'Running',
  idle: 'Waiting',
};

function FlashDemo(): ReactElement {
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

const MONTHS = ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const SAMPLE_ROWS = [
  { name: 'Homepage copy', owner: 'Writer', hours: '6.5' },
  { name: 'Booking page', owner: 'Designer', hours: '12.0' },
] as const;

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
  {
    id: 'DS-PRIM-11',
    name: 'Chip and pill',
    interactive: true,
    states: [
      { label: 'Outline', render: () => <Chip>Retainer</Chip> },
      { label: 'Soft', render: () => <Chip kind="soft">8 open</Chip> },
      { label: 'With glyph', render: () => <Chip icon="clock">Due Friday</Chip> },
      {
        label: 'Filter',
        render: () => (
          <Chip kind="filter" name="Owner" value="Account lead" onRemove={() => undefined} />
        ),
      },
      {
        label: 'Suggestion',
        render: () => (
          <Chip kind="suggestion" onClick={() => undefined}>
            Summarise this week
          </Chip>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-13',
    name: 'Count',
    interactive: false,
    states: [
      { label: 'Badge', render: () => <Count n={3} label="unread" /> },
      {
        label: 'Corner',
        render: () => (
          <span className="gallery__host">
            <Icon name="bell" />
            <Count n={12} label="unread" look="corner" />
          </span>
        ),
      },
      { label: 'Plain', render: () => <Count n={4} label="comments" look="plain" /> },
      { label: 'Numeral', render: () => <Count n={2} label="annotation" look="numeral" /> },
      { label: 'Inline', render: () => <Count n={11} label="in this filter" look="inline" /> },
    ],
  },
  {
    id: 'DS-PRIM-14',
    name: 'Dot and status line',
    interactive: false,
    states: TONES.map((tone) => ({
      label: tone,
      render: () => (
        <span className="smark">
          <StatusLine tone={tone} />
          <StatusLine tone={tone} node />
        </span>
      ),
    })),
  },
  {
    id: 'DS-PRIM-15',
    name: 'Status mark',
    interactive: false,
    states: [
      ...TONES.map((tone) => ({
        label: `Chip, ${tone}`,
        render: () => <StatusMark tone={tone}>{TONE_WORDS[tone]}</StatusMark>,
      })),
      {
        label: 'Text',
        render: () => (
          <StatusMark tone="ok" look="text">
            Connected
          </StatusMark>
        ),
      },
      {
        label: 'Line and word',
        render: () => (
          <StatusMark tone="warn" look="line">
            Waiting on review
          </StatusMark>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-16',
    name: 'Avatar and avatar stack',
    interactive: false,
    states: [
      { label: 'Person', render: () => <Avatar name="Account Lead" /> },
      {
        label: 'Person, large, on',
        render: () => <Avatar name="Account Lead" kind="person-large" presence="on" />,
      },
      {
        label: 'Person, large, away',
        render: () => <Avatar name="Account Lead" kind="person-large" presence="away" />,
      },
      { label: 'Client', render: () => <Avatar name="Sample Clinic" kind="client" /> },
      {
        label: 'Stack',
        render: () => (
          <AvatarStack
            people={[
              { name: 'Account Lead', here: true },
              { name: 'Designer' },
              { name: 'Writer' },
            ]}
          />
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-17',
    name: 'Icon and door mark',
    interactive: false,
    states: [
      {
        label: 'Icons',
        render: () => (
          <span className="gallery__icons">
            {GLYPH_NAMES.map((name) => (
              <Icon key={name} name={name} label={name} />
            ))}
          </span>
        ),
      },
      {
        label: 'Door to a page',
        render: () => (
          <span>
            Invoices
            <DoorMark to="page" />
          </span>
        ),
      },
      {
        label: 'Door to a new tab',
        render: () => (
          <span>
            Search Console
            <DoorMark to="external" />
          </span>
        ),
      },
      {
        label: 'The agent asks',
        render: () => (
          <span>
            Ask about this
            <DoorMark to="agent" />
          </span>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-18',
    name: 'Tooltip and callout',
    interactive: true,
    states: [
      {
        label: 'Below',
        render: () => <Term tip="Hours logged against the retainer this month">Burn</Term>,
      },
      {
        label: 'End',
        render: () => (
          <Term tip="Work the client has approved" place="end">
            Signed off
          </Term>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-25',
    name: 'Marker, tag, stamp, index and freshness',
    interactive: false,
    states: [
      { label: 'Section label', render: () => <Marker look="section">This week</Marker> },
      { label: 'Key tag', render: () => <Marker look="key">Owner</Marker> },
      { label: 'Stamp', render: () => <Marker look="stamp">Edited 2 min ago</Marker> },
      { label: 'Kind badge', render: () => <Marker look="kind">Agent</Marker> },
      { label: 'Index', render: () => <Index name="Period" value="1 to 20 July" /> },
      { label: 'Countdown', render: () => <Countdown minutesLeft={42} /> },
      { label: 'Expired', render: () => <Countdown minutesLeft={0} /> },
    ],
  },
  {
    id: 'DS-PRIM-26',
    name: 'Link and door link',
    interactive: true,
    states: [
      { label: 'Channel link', render: () => <Link href="#gallery">Open the channel</Link> },
      {
        label: 'Prose link',
        render: () => (
          <p>
            Read{' '}
            <Link look="prose" href="#gallery">
              the brief
            </Link>{' '}
            first.
          </p>
        ),
      },
      {
        label: 'Door link',
        render: () => <Link look="door" href="#gallery" label="Open the task" />,
      },
    ],
  },
  {
    id: 'DS-PRIM-27',
    name: 'Divider and rule',
    interactive: false,
    states: [
      { label: 'Rule', render: () => <Divider /> },
      { label: 'Section rule', render: () => <Divider look="section" /> },
      {
        label: 'Vertical',
        render: () => (
          <span className="smark">
            Sort
            <Divider look="vertical" />
            Filter
          </span>
        ),
      },
    ],
  },
  {
    id: 'DS-PRIM-19',
    name: 'Menu and popover',
    interactive: true,
    states: [
      { label: 'Option menu, open', render: () => <SelectDemo open /> },
      {
        label: 'Filter popover',
        render: () => (
          <span className="gallery__host gallery__host--popover">
            <Popover label="Filter tasks">
              <SegmentedDemo look="facet" />
            </Popover>
          </span>
        ),
      },
    ],
  },
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
  // The charts (MP-1-5), in their own unit. Sample numbers, never a record.
  {
    id: 'DS-COMP-27',
    name: 'Axis chart',
    interactive: true,
    states: [
      {
        label: 'Line',
        render: () => (
          <LineChart
            name="Monthly revenue"
            labels={MONTHS}
            series={[
              {
                label: 'Revenue',
                values: [18_200, 19_400, 21_000, 20_600, 22_800, 24_100],
                unit: 'money',
              },
            ]}
          />
        ),
      },
      {
        label: 'Two quantities, right axis',
        render: () => (
          <LineChart
            name="Revenue and managed spend"
            labels={MONTHS}
            series={[
              {
                label: 'Revenue',
                values: [18_200, 19_400, 21_000, 20_600, 22_800, 24_100],
                unit: 'money',
              },
              {
                label: 'Managed spend',
                values: [3_100, 3_400, 3_300, 4_000, 4_200, 4_600],
                unit: 'money',
                axis: 'right',
              },
            ]}
          />
        ),
      },
      {
        label: 'One point',
        render: () => (
          <LineChart
            name="Revenue so far"
            labels={['Oct']}
            series={[{ label: 'Revenue', values: [2_400], unit: 'money' }]}
          />
        ),
      },
      {
        label: 'Column with dashed line',
        render: () => (
          <ColumnChart
            name="Spend against genuine enquiries"
            labels={DAYS}
            bars={[{ label: 'Spend', values: [120, 80, 140, 60, 100, 90, 110], unit: 'money' }]}
            line={{
              label: 'Genuine enquiries',
              values: [1, 0, 2, 1, 3, 1, 2],
              unit: 'count',
              axis: 'right',
            }}
          />
        ),
      },
    ],
  },
  {
    id: 'DS-COMP-28',
    name: 'Radial chart',
    interactive: true,
    states: [
      {
        label: 'Donut with centre label',
        render: () => (
          <DonutChart
            name="Where enquiries came from"
            centre="46"
            centreLabel="Enquiries"
            slices={[
              { label: 'Search', value: 24 },
              { label: 'Ads', value: 14 },
              { label: 'Referral', value: 8 },
            ]}
          />
        ),
      },
      {
        label: 'Gauge with target',
        render: () => <Gauge name="Goal pacing" value={62} target={75} />,
      },
      {
        label: 'Score dials, three bands',
        render: () => (
          <div className="dials">
            <ScoreDial label="Performance" score={94} />
            <ScoreDial label="Accessibility" score={71} />
            <ScoreDial label="Best practice" score={38} />
          </div>
        ),
      },
    ],
  },
  {
    id: 'DS-COMP-29',
    name: 'Inline chart',
    interactive: false,
    states: [
      {
        label: 'Sparkline',
        render: () => (
          <Sparkline name="Enquiries, last eight weeks" values={[3, 5, 4, 6, 5, 8, 7, 9]} />
        ),
      },
    ],
  },
  {
    id: 'DS-COMP-40',
    name: 'Funnel chart',
    interactive: false,
    states: [
      {
        label: 'True-scale funnel',
        render: () => (
          <Funnel
            name="Search to booking"
            steps={[
              { label: 'Sessions', count: 5_200, context: true },
              { label: 'Enquiries', count: 400 },
              { label: 'Qualified', count: 180 },
              { label: 'Booked', count: 62 },
            ]}
          />
        ),
      },
    ],
  },
  {
    id: 'MP-1-6',
    name: 'Not connected, unavailable, freshness and sample data',
    interactive: true,
    states: [
      {
        label: 'Not connected',
        render: () => (
          <NotConnected
            source="Billing source"
            reason="No billing source is connected for this client, so there are no invoices to show."
            action={<Unavailable feature="Connecting a billing source" label="Connect" />}
          />
        ),
      },
      {
        label: 'Unavailable control',
        render: () => <Unavailable feature="Exporting invoices" label="Export CSV" />,
      },
      {
        label: 'Unavailable primary',
        render: () => <Unavailable feature="Online payment" label="Pay now" variant="primary" />,
      },
      {
        label: 'Live',
        render: () => <FreshnessMarker freshness={{ state: 'live', age: '2 min ago' }} />,
      },
      {
        label: 'Catching up',
        render: () => <FreshnessMarker freshness={{ state: 'catching-up', lastRead: '10:42' }} />,
      },
      {
        label: 'Offline',
        render: () => <FreshnessMarker freshness={{ state: 'offline', lastRead: '10:42' }} />,
      },
      {
        label: 'Source behind',
        render: () => (
          <FreshnessMarker
            freshness={{
              state: 'source-behind',
              source: 'Search Console',
              lastGood: '26 Sep, 6:10am',
              href: '#gallery',
            }}
          />
        ),
      },
      {
        label: 'Frozen',
        render: () => <FreshnessMarker freshness={{ state: 'frozen', at: 'Saturday 6:10am' }} />,
      },
      {
        label: 'Sample data, demo install only',
        render: () => (
          <SourceRegion provenance="mock">
            <Kpi label="Enquiries" value="31" />
          </SourceRegion>
        ),
      },
      {
        label: 'Real data, never marked',
        render: () => (
          <SourceRegion provenance="real">
            <Kpi label="Enquiries" value="29" />
          </SourceRegion>
        ),
      },
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
              <figure key={state.label} className="gallery__state" data-gallery-state={state.label}>
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
