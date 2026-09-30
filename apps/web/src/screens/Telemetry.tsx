// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings/telemetry/`: the service-health section (C34, CS-2.16), drawn
// from `operations.read`, C55's one read of the watcher and the error sink,
// never a second read.
//
// Four service states stay apart and each is said in words: healthy, a service
// failure, a stale observation and a service never observed. A source that
// could not be read is named with its kind of fault only, never the source's
// own words, and says nothing about the services it watches. Tracing is
// optional: switched off, it is "off", never a failure. An answer made
// in-process carries no section, and the page says so rather than drawing an
// empty, healthy-looking one.

import type { ReactElement, ReactNode } from 'react';
import { Card, Empty, StatusMark, Table, type MarkTone } from '@launchastro/ui';
import { useRead } from '../data/use-read.ts';
import type { OperationsClient } from '../operations/client.ts';
import { RecordState } from '../views/record-state.tsx';
import type {
  HealthSourceName,
  HealthSourceView,
  OperationsReadResult,
  ServiceHealthState,
} from '../../../../packages/core-wire/src/index.ts';

export interface TelemetryScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

const SOURCE_NAMES: Readonly<Record<HealthSourceName, string>> = {
  watcher: 'Installation watcher',
  'error-sink': 'Error sink',
  tracing: 'Tracing',
};

const SERVICE_STATES: Readonly<Record<ServiceHealthState, readonly [MarkTone, string]>> = {
  healthy: ['ok', 'Healthy'],
  'service-failure': ['bad', 'Service failure'],
  stale: ['warn', 'Stale'],
  'never-observed': ['idle', 'Never observed'],
};

function sourceState(source: HealthSourceView): readonly [MarkTone, string] {
  if (source.state === 'read') return ['ok', 'Read'];
  if (source.state === 'off') return ['idle', 'Off'];
  return ['bad', `Could not be read (${source.fault ?? 'no reason given'})`];
}

const SOURCE_COLUMNS = [
  { key: 'source', label: 'Source' },
  { key: 'state', label: 'State' },
];

const SERVICE_COLUMNS = [
  { key: 'service', label: 'Service' },
  { key: 'source', label: 'Seen by' },
  { key: 'state', label: 'State' },
  { key: 'seen', label: 'Last observed' },
];

type Section = NonNullable<OperationsReadResult['serviceHealth']>;

const sourceRows = (section: Section): readonly Record<string, ReactNode>[] =>
  section.sources.map((source) => {
    const [tone, words] = sourceState(source);
    return {
      source: <span data-source={source.source}>{SOURCE_NAMES[source.source]}</span>,
      state: <StatusMark tone={tone}>{words}</StatusMark>,
    };
  });

const serviceRows = (section: Section): readonly Record<string, ReactNode>[] =>
  section.services.map((service) => {
    const [tone, words] = SERVICE_STATES[service.state];
    return {
      service: <span data-service={service.name}>{service.name}</span>,
      source: SOURCE_NAMES[service.source],
      state: (
        <span data-state={service.state}>
          <StatusMark tone={tone}>{words}</StatusMark>
        </span>
      ),
      seen: service.lastObservedAt ?? 'never',
    };
  });

/** The page kit's section (PAGE-MAP SH-42): one head over what it holds. */
const HealthSec = (props: { readonly children: ReactNode }): ReactElement => (
  <section className="sec">
    <h2 className="sec__head">Service health</h2>
    {props.children}
  </section>
);

function Health(props: {
  readonly result: OperationsReadResult;
  readonly businessKey: string;
}): ReactElement {
  const section = props.result.serviceHealth;
  if (section === undefined) {
    return (
      <HealthSec>
        <div data-health="absent">
          <Empty
            title="Service health is not in this answer."
            description="The watcher and the error sink are read by the API; this answer did not come through it."
          />
        </div>
      </HealthSec>
    );
  }
  return (
    <HealthSec>
      <p className="card__sub">
        For {props.businessKey}, from the operations read, checked at {section.checkedAt}.
      </p>
      <div className="stack" data-health-cards>
        <div data-health="sources">
          <Card title="Sources" sub="Where service health is read from">
            <Table
              caption="Where service health is read from"
              columns={SOURCE_COLUMNS}
              rows={sourceRows(section)}
              dense
            />
          </Card>
        </div>
        <div data-health="services">
          <Card title="Services" sub="Each service as its source last saw it">
            <Table
              caption="Each service as its source last saw it"
              columns={SERVICE_COLUMNS}
              rows={serviceRows(section)}
            />
          </Card>
        </div>
      </div>
    </HealthSec>
  );
}

export function TelemetryScreen(props: TelemetryScreenProps): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<OperationsReadResult>({
    grantKey,
    run: () => client.read<OperationsReadResult>('operations.read', {}),
    deps: [client],
  });
  // The top bar names the page; the body is the page kit's sections (PAGE-MAP SH-40 to 44).
  return (
    <div className="secs" data-screen="telemetry" data-business={client.businessKey}>
      <RecordState state={state} subject="service health" onRetry={reload}>
        {(result) => <Health result={result} businessKey={client.businessKey} />}
      </RecordState>
    </div>
  );
}
