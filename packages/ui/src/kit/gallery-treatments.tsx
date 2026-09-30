// SPDX-License-Identifier: AGPL-3.0-only
//
// The component gallery: the not-connected, unavailable, freshness and
// sample treatments (MP-1-6).

import { Kpi } from './blocks.tsx';
import { FreshnessMarker, NotConnected, SourceRegion, Unavailable } from './treatments.tsx';
import type { GalleryEntry } from './gallery-entry.ts';

export const TREATMENTS: readonly GalleryEntry[] = [
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
