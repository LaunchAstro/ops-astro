// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery (MP-1-3): the marks, the icon, the tooltip and the
// option menu, in catalogue order.

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
} from './marks.tsx';
import { GLYPH_NAMES, Icon } from '../primitives/Icon.tsx';
import { Popover } from './blocks.tsx';
import type { GalleryEntry } from './gallery-entry.ts';
import { SelectDemo, SegmentedDemo, TONES, TONE_WORDS } from './gallery-demos.tsx';

export const MARKS: readonly GalleryEntry[] = [
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
        render: () => <Chip kind="filter" name="Owner" value="Account lead" onRemove={() => {}} />,
      },
      {
        label: 'Suggestion',
        render: () => (
          <Chip kind="suggestion" onClick={() => {}}>
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
];
