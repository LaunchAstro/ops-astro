// SPDX-License-Identifier: AGPL-3.0-only
//
// The scope stamp (MP-6-4, DS-TASK-3, DP-31, DP-32, TA-08): what the run was
// allowed to touch, read-only, with the rule that a task may narrow its grant
// and never widen it, the grants it draws on linked into the access ledger,
// and the context snapshot line. It offers no control: the broker set the
// scope with the lease, and nothing on the task page edits it (R76).

import type { ReactElement } from 'react';
import type { ScopeStamp } from '../../state/agent-scope.ts';
import type { RunVersion } from '../../state/run-projection.ts';
import { shortDigest } from './format.ts';

type Delegation = Extract<ScopeStamp, { readonly kind: 'agent' }>['delegation'];

export interface ScopeProps {
  readonly stamp: ScopeStamp;
  /** The version the run works: what its context was pinned to. */
  readonly head: RunVersion;
  readonly nameOf: (personId: string) => string;
  /** The ledger's address for one grant, or null while the ledger has no screen. */
  readonly ledgerHref: ((grantId: string) => string) | null;
}

export function Scope(props: ScopeProps): ReactElement {
  const { stamp } = props;
  if (stamp.kind === 'none') {
    return (
      <p className="sbact__meta" data-agent="scope" data-scope="none">
        No scope has been issued on this task yet.
      </p>
    );
  }
  if (stamp.kind === 'person') {
    return (
      <div data-agent="scope" data-scope="person">
        <p className="sbact__meta">
          A person holds this run’s lease under their own grants; there is no delegation to show.
        </p>
        <SnapshotLine head={props.head} acquiredAt={stamp.acquiredAt} />
      </div>
    );
  }
  return <AgentScope {...props} stamp={stamp} />;
}

/** An agent's run: the stamp, its say-line and ledger links, the snapshot line and the facts. */
function AgentScope(
  props: ScopeProps & { readonly stamp: Extract<ScopeStamp, { readonly kind: 'agent' }> },
): ReactElement {
  const { stamp } = props;
  return (
    <div data-agent="scope" data-scope="agent" data-scope-state={stamp.delegation.state}>
      <div className="mstamp" title="Set by the broker when the run was issued. Not editable here.">
        <span className="tf__k">Scope</span>
        <span className="mstamp__v">
          <span className="mstamp__lock" aria-hidden="true" />
          <span className="mstamp__p" data-scope-part="reach">
            {stamp.reach}
          </span>
          <span className="mstamp__x" aria-hidden="true">
            ×
          </span>
          <span className="mstamp__p" data-scope-part="lane">
            {stamp.lane}
          </span>
          <span className="mstamp__x" aria-hidden="true">
            ×
          </span>
          <span className="spill mstamp__chip" data-scope-part="clearance">
            {stamp.clearance}
          </span>
        </span>
        <span className="mstamp__say" data-agent="scope-say">
          Machine-set with the grant. Not editable here: a task may narrow what its grant allows,
          never widen it. <LedgerLinks grants={stamp.delegation.grants} href={props.ledgerHref} />
        </span>
      </div>
      <SnapshotLine head={props.head} acquiredAt={stamp.acquiredAt} />
      <ScopeFacts
        delegation={stamp.delegation}
        reach={stamp.reach}
        reaches={stamp.reaches}
        writes={stamp.writes}
        nameOf={props.nameOf}
      />
    </div>
  );
}

function LedgerLinks(props: {
  readonly grants: Delegation['grants'];
  readonly href: ScopeProps['ledgerHref'];
}): ReactElement {
  if (props.grants.length === 0) {
    return (
      <span data-agent="ledger-none">
        The delegating person holds no live grant it can draw on, so it can do nothing.
      </span>
    );
  }
  const { href } = props;
  return (
    <>
      {props.grants.map((grant) => {
        const label = `${grant.collection} ${grant.action}, ${grant.scopeKind === 'record' ? 'this task' : 'business-wide'}`;
        return href === null ? (
          <span key={grant.id} className="sb__addr" data-ledger-grant={grant.id}>
            {label}{' '}
          </span>
        ) : (
          <a key={grant.id} className="sb__addr" href={href(grant.id)} data-ledger-grant={grant.id}>
            {label}{' '}
          </a>
        );
      })}
    </>
  );
}

function SnapshotLine(props: {
  readonly head: RunVersion;
  readonly acquiredAt: string;
}): ReactElement {
  return (
    <div className="trs__snap" data-agent="snapshot-line">
      <span className="sbact__meta u-mono">
        Context snapshot v{props.head.version} {shortDigest(props.head.payloadDigest)} · pinned{' '}
        {props.acquiredAt}
      </span>
    </div>
  );
}

function ScopeFacts(props: {
  readonly delegation: Delegation;
  readonly reach: string;
  readonly reaches: string;
  readonly writes: boolean;
  readonly nameOf: ScopeProps['nameOf'];
}): ReactElement {
  const { delegation } = props;
  return (
    <div className="sout__box" data-agent="scope-facts">
      <div className="sout__row" data-scope-fact="write">
        <span className="tf__k">Write access</span>
        <span className="sb__state">
          {props.writes
            ? 'Granted for this run.'
            : 'None. This run can read and stage, and cannot publish.'}
        </span>
      </div>
      <div className="sout__row" data-scope-fact="grant">
        <span className="tf__k">Grant</span>
        <span className="sb__state u-mono">
          Delegation {delegation.id} from {props.nameOf(delegation.delegatePersonId)}
        </span>
      </div>
      <div className="sout__row" data-scope-fact="constraints">
        <span className="tf__k">Constraints</span>
        <span className="sb__state">
          {`Reaches ${props.reaches} on ${props.reach}. `}
          {`Never wider than ${props.nameOf(delegation.delegatePersonId)}’s own live grants. `}
          {delegation.state === 'live'
            ? `Until ${delegation.expiresAt}.`
            : `No longer live: ${delegation.state}.`}
        </span>
      </div>
    </div>
  );
}
