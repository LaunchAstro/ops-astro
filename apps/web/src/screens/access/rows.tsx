// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's three lists (C32): Team, Clients and Agents, each row
// with what the grant check would allow now. A client is named only from the
// read's own client records; a scope the read does not list is said as that.

import type { ReactElement } from 'react';
import { Button, Card, Chip, Table } from '@launchastro/ui';
import type {
  AccessGrant,
  AccessPermission,
  AccessReadResult,
  ClientView,
  PersonView,
} from '../../../../../packages/core-wire/src/index.ts';

/** What a permission reaches, in words; a client only by the read's own record. */
export function scopeWords(
  scope: AccessPermission['scope'],
  clients: readonly ClientView[],
): string {
  if (scope.kind === 'business') return 'whole business';
  if (scope.kind === 'record') return 'one record';
  return clients.find((each) => each.clientId === scope.id)?.name ?? 'a client not listed here';
}

function Preview(props: {
  readonly permissions: readonly AccessPermission[];
  readonly clients: readonly ClientView[];
}): ReactElement {
  if (props.permissions.length === 0) return <span className="card__sub">No permission</span>;
  return (
    <>
      {props.permissions.map((each) => {
        const words = `${each.collection}:${each.action} · ${scopeWords(each.scope, props.clients)}`;
        return <Chip key={words}>{words}</Chip>;
      })}
    </>
  );
}

/** Each live grant behind the preview, by its own Revoke act. */
function Grants(props: {
  readonly grants: readonly AccessGrant[];
  readonly clients: readonly ClientView[];
  readonly onRevoke: (grant: AccessGrant) => void;
}): ReactElement {
  if (props.grants.length === 0) return <span className="card__sub">No grant</span>;
  return (
    <>
      {props.grants.map((grant) => (
        <span key={grant.grantId} data-revoke-grant={grant.grantId}>
          <Chip>{`${grant.collection}:${grant.action} · ${scopeWords(grant.scope, props.clients)}`}</Chip>
          <Button variant="ghost" onClick={() => props.onRevoke(grant)}>
            Revoke
          </Button>
        </span>
      ))}
    </>
  );
}

const PEOPLE_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'preview', label: 'May do now' },
  { key: 'grants', label: 'Grants' },
  { key: 'act', label: '', align: 'end' as const },
];

const AGENT_COLUMNS = PEOPLE_COLUMNS.filter((column) => column.key !== 'grants');

export function People(props: {
  readonly id: 'team' | 'clients';
  readonly title: string;
  readonly people: AccessReadResult['team'];
  readonly clients: readonly ClientView[];
  readonly onEnd: (person: PersonView) => void;
  readonly onRevokeGrant: (person: PersonView, grant: AccessGrant) => void;
}): ReactElement {
  const rows = props.people.map((person) => ({
    name: <span data-person={person.personId}>{person.name}</span>,
    preview: <Preview permissions={person.permissions} clients={props.clients} />,
    grants: (
      <Grants
        grants={person.grants}
        clients={props.clients}
        onRevoke={(grant) => props.onRevokeGrant(person, grant)}
      />
    ),
    act: (
      <span data-end={person.personId}>
        <Button onClick={() => props.onEnd(person)}>End access</Button>
      </span>
    ),
  }));
  return (
    <div data-access={props.id}>
      <Card title={props.title} flush>
        <Table caption={props.title} columns={PEOPLE_COLUMNS} rows={rows} />
      </Card>
    </div>
  );
}

export function Agents(props: {
  readonly result: AccessReadResult;
  readonly onRevoke: (agent: AccessReadResult['agents'][number]) => void;
}): ReactElement {
  const rows = props.result.agents.map((agent) => ({
    name: (
      <span data-agent={agent.delegationId}>
        {agent.purpose} · for {agent.person.name}
      </span>
    ),
    preview: <Preview permissions={agent.permissions} clients={props.result.clientRecords} />,
    act: (
      <span data-revoke={agent.delegationId}>
        <Button onClick={() => props.onRevoke(agent)}>Revoke delegation</Button>
      </span>
    ),
  }));
  return (
    <div data-access="agents">
      <Card title="Agents" sub="Each on a live delegation from a person, until it expires" flush>
        <Table caption="Agents" columns={AGENT_COLUMNS} rows={rows} />
      </Card>
    </div>
  );
}
