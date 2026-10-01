// SPDX-License-Identifier: AGPL-3.0-only
//
// Three sections of the operations view (C55) whose reads are not served yet:
// the security alerts S0-2 raises, the last tested restore from S0-3's drill
// receipt, and the link to the error sink. `operations.read` leaves them out
// until those reads land (BUILDABLE-NOW decisions 6 and 7). A field the read
// carries is drawn as real, with no label; an absent one draws `HELD_MOCK`
// inside the kit's MockRegion, labelled Mock (MOCK-1PM point 3).

import type { ReactElement, ReactNode } from 'react';
import { Card, Empty, MockRegion, StatusMark, Table } from '@launchastro/ui';
import type {
  LastTestedRestoreView,
  OperationsReadResult,
  SecurityAlertView,
} from '../../../../../packages/core-wire/src/index.ts';

/** Made-up values, drawn only under the Mock label while a read is not served. */
export const HELD_MOCK = {
  securityAlerts: [
    {
      kind: 'api_key.misuse',
      at: '2026-01-05T09:00:00.000Z',
      concerns: 'Made-up: an API key used from an unknown address',
    },
    {
      kind: 'sign_in.burst',
      at: '2026-01-04T22:30:00.000Z',
      concerns: 'Made-up: repeated failed sign-ins for one person',
    },
  ],
  lastTestedRestore: { at: '2026-01-03T02:00:00.000Z', stale: false },
  errorSink: { url: 'https://errors.example.invalid/made-up' },
} as const satisfies {
  readonly securityAlerts: readonly SecurityAlertView[];
  readonly lastTestedRestore: LastTestedRestoreView;
  readonly errorSink: { readonly url: string };
};

/** One held section: served, drawn as is; absent, the made-up body under the Mock label. */
function Held(props: {
  readonly name: string;
  readonly title: string;
  readonly sub: string;
  readonly served: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div data-section={props.name}>
      <Card title={props.title} sub={props.sub}>
        {props.served ? (
          props.children
        ) : (
          <div data-mock={props.name}>
            <MockRegion word>
              <p className="card__sub">Made-up values until this read is served.</p>
              {props.children}
            </MockRegion>
          </div>
        )}
      </Card>
    </div>
  );
}

const ALERT_COLUMNS = [
  { key: 'kind', label: 'Alert' },
  { key: 'at', label: 'Raised' },
  { key: 'concerns', label: 'What it concerns' },
];

/** Only the kind, the time and what it concerns: never a secret or record content. */
function AlertTable(props: { readonly alerts: readonly SecurityAlertView[] }): ReactElement {
  if (props.alerts.length === 0) return <Empty title="No security alert is raised." />;
  return (
    <Table
      caption="Security alerts, most recent first"
      columns={ALERT_COLUMNS}
      rows={props.alerts.map((alert) => ({
        kind: alert.kind,
        at: alert.at,
        concerns: alert.concerns,
      }))}
    />
  );
}

function RestoreLine(props: { readonly restore: LastTestedRestoreView }): ReactElement {
  const { at, stale } = props.restore;
  return (
    <p className="card__sub" data-restore={at ?? 'never'}>
      {at === null ? 'A restore has never been tested.' : `Last tested restore: ${at}.`}{' '}
      {stale ? <StatusMark tone="warn">Stale</StatusMark> : null}
    </p>
  );
}

function SinkLink(props: { readonly sink: { readonly url: string } | null }): ReactElement {
  if (props.sink === null) return <p className="card__sub">No error sink is configured.</p>;
  return (
    <p className="card__sub">
      <a href={props.sink.url} data-link="error-sink" target="_blank" rel="noreferrer">
        Open the error sink
      </a>
    </p>
  );
}

/** The three held sections, placed together on the operations view. */
export function HeldSections(props: { readonly result: OperationsReadResult }): ReactElement {
  const { securityAlerts, lastTestedRestore, errorSink } = props.result;
  return (
    <>
      <Held
        name="security-alerts"
        title="Security alerts"
        sub="Each with its time and what it concerns"
        served={securityAlerts !== undefined}
      >
        <AlertTable alerts={securityAlerts ?? HELD_MOCK.securityAlerts} />
      </Held>
      <Held
        name="last-restore"
        title="Last tested restore"
        sub="From the restore drill's receipt"
        served={lastTestedRestore !== undefined}
      >
        <RestoreLine restore={lastTestedRestore ?? HELD_MOCK.lastTestedRestore} />
      </Held>
      <Held
        name="error-sink"
        title="Error sink"
        sub="Where the installation's errors are collected"
        served={errorSink !== undefined}
      >
        <SinkLink sink={errorSink === undefined ? HELD_MOCK.errorSink : errorSink} />
      </Held>
    </>
  );
}
