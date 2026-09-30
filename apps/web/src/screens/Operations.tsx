// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings/operations/`: the operations view (C55, CS-14.31), drawn from
// `operations.read` alone, behind `operations:read`. It places other parts'
// reads and keeps no list of its own: INB-1's unattended items (every path to
// a person broken), the privacy incidents with the breach runbook they link
// (C81), and C34's service-health section, the same one Settings ▸ Telemetry
// draws. Security alerts, the last tested restore and the error sink link are
// drawn labelled Mock until their reads are served (operations/held-sections).
// A refused read is drawn denied, never as an empty view. Its one write,
// recording a privacy incident (`privacy.record_incident`, under
// `privacy:manage`, as on the API and the command line), is
// `operations/record-incident.tsx`, below the incidents card.

import type { ReactElement, ReactNode } from 'react';
import { Card, Empty, StatusMark, Table } from '@launchastro/ui';
import { useRead } from '../data/use-read.ts';
import type { OperationsClient } from '../operations/client.ts';
import { RecordState } from '../views/record-state.tsx';
import { Health } from './Telemetry.tsx';
import { HeldSections } from './operations/held-sections.tsx';
import { RecordIncident } from './operations/record-incident.tsx';
import type {
  OperationsReadResult,
  PrivacyIncidentView,
  UnattendedView,
} from '../../../../packages/core-wire/src/index.ts';

export interface OperationsScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

/** What each unattended item is owed for, said of its recipient. */
const REASON: Readonly<Record<UnattendedView['reason'], string>> = {
  decision: 'Decision',
  waiting_run: 'Run waiting on a move',
  run_finished: 'Run finished',
  assignment: 'Assignment',
  mention: 'Mention',
  incident: 'Incident',
  client_comment: 'Client comment',
};

const UNATTENDED_COLUMNS = [
  { key: 'reason', label: 'Owed for' },
  { key: 'recipient', label: 'Recipient' },
  { key: 'task', label: 'Task' },
  { key: 'raised', label: 'Raised' },
];

const INCIDENT_COLUMNS = [
  { key: 'what', label: 'What happened' },
  { key: 'found', label: 'Found' },
  { key: 'assess', label: 'Assess by' },
  { key: 'status', label: 'Status' },
];

const unattendedRows = (items: readonly UnattendedView[]): readonly Record<string, ReactNode>[] =>
  items.map((item) => ({
    reason: <span data-unattended={item.id}>{REASON[item.reason]}</span>,
    recipient: item.recipientPersonId,
    task: item.subjectRecordId,
    raised: item.raisedAt,
  }));

function incidentStatus(incident: PrivacyIncidentView): ReactElement {
  if (incident.overdue) return <StatusMark tone="bad">Overdue</StatusMark>;
  return incident.status === 'open' ? (
    <StatusMark tone="warn">Open</StatusMark>
  ) : (
    <StatusMark tone="ok">Closed</StatusMark>
  );
}

const incidentRows = (
  incidents: readonly PrivacyIncidentView[],
): readonly Record<string, ReactNode>[] =>
  incidents.map((incident) => ({
    what: <span data-incident={incident.id}>{incident.whatHappened}</span>,
    found: incident.foundAt,
    assess: incident.assessBy,
    status: incidentStatus(incident),
  }));

function Unattended(props: { readonly items: readonly UnattendedView[] }): ReactElement {
  return (
    <div data-section="unattended">
      <Card title="Unattended" sub="Items no person can be reached for, from the inbox">
        {props.items.length === 0 ? (
          <Empty
            title="Nothing is unattended."
            description="Every open item has a person who can act on it."
          />
        ) : (
          <Table
            caption="Items no person can be reached for"
            columns={UNATTENDED_COLUMNS}
            rows={unattendedRows(props.items)}
          />
        )}
      </Card>
    </div>
  );
}

function Incidents(props: { readonly result: OperationsReadResult }): ReactElement {
  const { privacyIncidents, breachRunbook } = props.result;
  return (
    <div data-section="incidents">
      <Card title="Privacy incidents" sub="Each is assessed within 30 days of being found">
        <p className="card__sub" data-runbook={breachRunbook?.version ?? 'none'}>
          {breachRunbook === null
            ? 'No breach runbook is published.'
            : `Breach runbook version ${breachRunbook.version}, published ${breachRunbook.publishedAt}.`}
        </p>
        {privacyIncidents.length === 0 ? (
          <Empty title="No privacy incident is recorded." />
        ) : (
          <Table
            caption="Privacy incidents, most recently found first"
            columns={INCIDENT_COLUMNS}
            rows={incidentRows(privacyIncidents)}
          />
        )}
      </Card>
    </div>
  );
}

export function OperationsScreen(props: OperationsScreenProps): ReactElement {
  const { client, grantKey } = props;
  const { state, reload } = useRead<OperationsReadResult>({
    grantKey,
    run: () => client.read<OperationsReadResult>('operations.read', {}),
    deps: [client],
  });
  return (
    <div className="stack" data-screen="operations" data-business={client.businessKey}>
      <header className="tpr">
        <h2 className="tpr__title">Operations</h2>
        <div className="card__sub">
          What needs an operator in {client.businessKey}: unattended items, privacy incidents and
          service health.
        </div>
      </header>
      <RecordState state={state} subject="the operations view" onRetry={reload}>
        {(result) => (
          <>
            <Unattended items={result.unattended} />
            <HeldSections result={result} />
            <Incidents result={result} />
            <RecordIncident client={client} onRecorded={reload} />
            <Health result={result} />
          </>
        )}
      </RecordState>
    </div>
  );
}
