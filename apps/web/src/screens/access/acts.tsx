// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's two acts: giving one person one permission over the
// whole business or one client (C32, `access.grant`), and the confirmation
// C58's End access waits on before anything is sent.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Card, Select, type Option } from '@launchastro/ui';
import {
  GRANTABLE_KEYS,
  type AccessGrant,
  type AccessReadResult,
  type PersonView,
} from '../../../../../packages/core-wire/src/index.ts';
import { scopeWords } from './rows.tsx';

const WHOLE_BUSINESS = '';

/** One kit select, marked by the field it fills so a check can find it. */
function Choice(props: {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly Option[];
}): ReactElement {
  return (
    <div data-field={props.field}>
      <Select
        label={props.label}
        value={props.value}
        onChange={props.onChange}
        options={props.options}
      />
    </div>
  );
}

const KEYS: readonly Option[] = GRANTABLE_KEYS.map((each) => ({ value: each, label: each }));

export function GiveAccess(props: {
  readonly result: AccessReadResult;
  readonly busy: boolean;
  readonly onGive: (holder: PersonView, key: string, clientId: string | null) => void;
}): ReactElement {
  const people = [...props.result.team, ...props.result.clients];
  const [holder, setHolder] = useState('');
  const [key, setKey] = useState('');
  const [scope, setScope] = useState(WHOLE_BUSINESS);
  const chosen = people.find((person) => person.personId === holder);
  const over = [
    { value: WHOLE_BUSINESS, label: 'The whole business' },
    ...props.result.clientRecords.map((each) => ({ value: each.clientId, label: each.name })),
  ];
  const give = (event: FormEvent): void => {
    event.preventDefault();
    if (chosen === undefined || key === '') return;
    props.onGive(chosen, key, scope === WHOLE_BUSINESS ? null : scope);
  };
  return (
    <div data-access="give">
      <Card title="Give access" sub="One permission, over the whole business or one client">
        <form className="stack" onSubmit={give}>
          <Choice
            field="holder"
            label="Person"
            value={holder}
            onChange={setHolder}
            options={people.map((person) => ({ value: person.personId, label: person.name }))}
          />
          <Choice field="key" label="Permission" value={key} onChange={setKey} options={KEYS} />
          <Choice field="scope" label="Over" value={scope} onChange={setScope} options={over} />
          <Button
            type="submit"
            variant="primary"
            busy={props.busy ? 'Giving access…' : undefined}
            disabled={chosen === undefined || key === ''}
          >
            Give access
          </Button>
        </form>
      </Card>
    </div>
  );
}

export function ConfirmEnd(props: {
  readonly person: PersonView;
  readonly onEnd: () => void;
  readonly onKeep: () => void;
}): ReactElement {
  return (
    <div data-confirm="end-access">
      <Card
        title={`End ${props.person.name}'s access?`}
        sub="Their login is deactivated, every session they hold ends and every grant they hold is revoked, in one act."
      >
        <span data-act="end">
          <Button variant="primary" onClick={props.onEnd}>
            End access now
          </Button>
        </span>
        <span data-act="keep">
          <Button variant="ghost" onClick={props.onKeep}>
            Keep access
          </Button>
        </span>
      </Card>
    </div>
  );
}

/** A person and one grant of theirs, waiting on the confirmation before `access.revoke`. */
export interface Revoking {
  readonly person: PersonView;
  readonly grant: AccessGrant;
}

export function ConfirmRevokeGrant(props: {
  readonly revoking: Revoking;
  readonly result: AccessReadResult;
  readonly onRevoke: () => void;
  readonly onKeep: () => void;
}): ReactElement {
  const { person, grant } = props.revoking;
  const over = scopeWords(grant.scope, props.result.clientRecords);
  return (
    <div data-confirm="revoke-grant">
      <Card
        title={`Revoke ${person.name}'s ${grant.collection}:${grant.action} over ${over}?`}
        sub="Only this grant ends; their other grants and their login stay."
      >
        <span data-act="revoke">
          <Button variant="primary" onClick={props.onRevoke}>
            Revoke grant
          </Button>
        </span>
        <span data-act="keep">
          <Button variant="ghost" onClick={props.onKeep}>
            Keep grant
          </Button>
        </span>
      </Card>
    </div>
  );
}
