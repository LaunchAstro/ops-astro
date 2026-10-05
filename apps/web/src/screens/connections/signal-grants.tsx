// SPDX-License-Identifier: AGPL-3.0-only
//
// Section 006, Grants (MP-14-8): what access is live right now, and for how
// long. A grant is a named agent's time-boxed claim for one job. The three
// groups (Live, Ran out, Taken back) are banners, not a filter, and a group is
// drawn only when it has rows. A fleet grant is marked, never blank, and a
// grant whose client has no `clients` row is an unnamed client, never fleet.

import type { ReactElement } from 'react';
import { SectionHead } from '@launchastro/ui';
import type {
  ConnectionSignalResult,
  GrantView,
} from '../../../../../packages/core-wire/src/index.ts';
import { causeOf, countdownOf, grantsLede, plural, stamp } from './signal-view.ts';

const GROUPS: readonly {
  readonly state: GrantView['state'];
  readonly title: string;
  readonly tone: 'ok' | 'idle' | 'warn';
  readonly say: string;
}[] = [
  { state: 'live', title: 'Live', tone: 'ok', say: 'Held now; each runs out on its own clock.' },
  {
    state: 'ran_out',
    title: 'Ran out',
    tone: 'idle',
    say: 'Expired or settled. Kept on the ledger: the expiry says how long a job has been stuck.',
  },
  {
    state: 'taken_back',
    title: 'Taken back',
    tone: 'warn',
    say: 'Revoked before it ran out, each with its cause.',
  },
];

export function CeilingChip(): ReactElement {
  return (
    <span className="chip" aria-disabled="true" title="The clearance documents are not built yet">
      Ceiling
    </span>
  );
}

function GrantRow(props: { readonly grant: GrantView; readonly now: number }): ReactElement {
  const { grant } = props;
  const ttl = countdownOf(grant, props.now);
  const access = grant.access === 'read' ? 'Reads only' : 'Can change what it reaches';
  return (
    <li className="grl__row" data-grant={grant.id}>
      <p>
        <strong>{grant.agentId.slice(0, 8)}</strong> {grant.purpose}
      </p>
      <p>
        {/* A client's name is free text: isolated, so it cannot reorder the line. */}
        {grant.client === null ? (
          <span className="chip chip--outline is-warn" data-grant-fleet>
            Fleet · every client
          </span>
        ) : (
          <>
            <span className="visually-hidden">Client: </span>
            <bdi data-grant-client>{grant.client.label ?? 'Client (no name)'}</bdi>
          </>
        )}{' '}
        · {grant.collections.join(', ')}{' '}
        <span className="tag" data-grant-access title={access}>
          {grant.access}
        </span>{' '}
        <CeilingChip />{' '}
        <span data-grant-ttl data-tone={ttl.tone} title={`Issued ${stamp(grant.grantedAt)}`}>
          {ttl.words}
        </span>{' '}
        <span data-grant-reads>
          {grant.redemptions === 0 ? 'Never redeemed' : plural(grant.redemptions, 'read')}
        </span>
      </p>
      {grant.state === 'taken_back' ? (
        <p className="t-2">Taken back: {causeOf(grant.revocationCause)}</p>
      ) : null}
    </li>
  );
}

export function GrantsSection(props: {
  readonly signal: ConnectionSignalResult;
  readonly now: number;
}): ReactElement {
  const { grants, grantCounts } = props.signal;
  const lede = grantsLede(grantCounts.live, grantCounts.liveExec);
  return (
    <section id="grants" data-section="006">
      <SectionHead index="006" title="Grants" right="What is live right now" />
      {lede === null ? null : <p className="grl__lede">{lede}</p>}
      {grants.length === 0 ? <p>No grants you can see.</p> : null}
      {GROUPS.map((group) => {
        const rows = grants.filter((one) => one.state === group.state);
        if (rows.length === 0) return null;
        return (
          <div
            className="grl__grp card card--flush"
            key={group.state}
            data-grant-group={group.state}
          >
            <p className="grl__banner">
              <span className={`chip chip--outline is-${group.tone}`}>{group.title}</span>{' '}
              {rows.length} {group.say}
            </p>
            <ul>
              {rows.map((grant) => (
                <GrantRow key={grant.id} grant={grant} now={props.now} />
              ))}
            </ul>
          </div>
        );
      })}
      <p className="approval__meta">
        Reads count the calls made under a grant; nothing records what each one reached. A grant
        runs out on its own clock, and one that ran out stays here.
      </p>
    </section>
  );
}
