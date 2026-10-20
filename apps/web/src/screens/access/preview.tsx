// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's preview of one teammate (C32, owner check U14): what the
// grant check would allow them now and which clients that reaches, from
// `access.read`'s own row for them and nothing else. It sends nothing and asks
// no other read; each reread after an act redraws it, so a grant shows here
// only once the server lists it. A client is named only from the read's
// client records; a scope the read does not list is said as that.

import { useState, type ReactElement } from 'react';
import { Button, Card } from '@launchastro/ui';
import type { AccessPerson, ClientView } from '../../../../../packages/core-wire/src/index.ts';
import { Preview, scopeWords, STEP_UP_WORDS } from './rows.tsx';

/** Where their permissions reach, each place once, in the read's order. */
const reachOf = (person: AccessPerson, clients: readonly ClientView[]): readonly string[] => [
  ...new Set(person.permissions.map((each) => scopeWords(each.scope, clients))),
];

export function AccessPreview(props: {
  readonly person: AccessPerson;
  readonly clients: readonly ClientView[];
  readonly onClose: () => void;
}): ReactElement {
  const { person, clients } = props;
  const reach = reachOf(person, clients);
  return (
    <div data-access="preview">
      <Card
        title={`What ${person.name} may do now`}
        sub="As the server grants it now, read again after each change"
      >
        {reach.length === 0 ? null : <p className="card__sub">Reaches {reach.join(', ')}</p>}
        <div className="btnrow">
          <Preview
            permissions={person.permissions}
            clients={clients}
            stepUpWords={STEP_UP_WORDS.team}
          />
        </div>
        <span data-act="close-preview">
          <Button variant="ghost" onClick={props.onClose}>
            Close preview
          </Button>
        </span>
      </Card>
    </div>
  );
}

/**
 * Preview access for the teammate chosen in Give access, drawn from this
 * read's row for them: a reread redraws it, and a person no longer listed has
 * none.
 */
export function PreviewAccess(props: {
  readonly people: readonly AccessPerson[];
  readonly holder: string;
  readonly clients: readonly ClientView[];
}): ReactElement {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewed = props.people.find((person) => person.personId === previewing);
  const chosen = props.people.some((person) => person.personId === props.holder);
  return (
    <>
      <div className="btnrow">
        <span data-act="preview">
          <Button
            variant="secondary"
            onClick={() => setPreviewing(props.holder)}
            disabled={!chosen}
          >
            Preview access
          </Button>
        </span>
      </div>
      {previewed === undefined ? null : (
        <AccessPreview
          person={previewed}
          clients={props.clients}
          onClose={() => setPreviewing(null)}
        />
      )}
    </>
  );
}
