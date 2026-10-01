// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery: the charts (MP-1-5). Sample numbers, never a record.

import {
  ColumnChart,
  DonutChart,
  Funnel,
  Gauge,
  LineChart,
  ScoreDial,
  Sparkline,
} from './charts.tsx';
import type { GalleryEntry } from './gallery-entry.ts';
import { MONTHS, DAYS } from './gallery-demos.tsx';

export const CHARTS: readonly GalleryEntry[] = [
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
];
