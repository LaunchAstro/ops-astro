// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's alerts (T2h): each transition the run made into settled,
// failed or cancelled, or into a wait only a person can end, newest first as
// the read sent them. A kind or reason this build does not know prints raw.

import type { ReactElement } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { TaskAlert } from '../../../../../packages/core-wire/src/index.ts';

const KINDS: Readonly<Record<string, string>> = {
  settled: 'Settled',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const WAITING: Readonly<Record<string, string>> = {
  needs_approval: 'A person decides the next version.',
  liability_unknown:
    'The cost reported is above the hold. A person records this attempt’s outcome.',
  quarantined: 'The hold is kept. A person reconciles this attempt.',
};

function say(alert: TaskAlert): string {
  if (alert.kind !== 'awaiting_person') return KINDS[alert.kind] ?? alert.kind;
  const reason = alert.waitingReason ?? '';
  return `Waiting on a person. ${WAITING[reason] ?? reason}`;
}

export function Alerts(props: {
  readonly alerts: readonly TaskAlert[] | undefined;
}): ReactElement | null {
  if (props.alerts === undefined) return null;
  return (
    <section className="sb__sect" data-alerts={props.alerts.length === 0 ? 'none' : 'some'}>
      <div className="sb__sh">
        <span className="sb__k">Alerts</span>
      </div>
      {props.alerts.length === 0 ? (
        <PaneEmpty say="No alert on this task." />
      ) : (
        <div className="sbact">
          {props.alerts.map((alert) => (
            <div className="sbact__row" key={alert.id} data-alert-kind={alert.kind}>
              <span className="sbact__meta">{alert.raisedAt}</span>
              <span className="sb__state">{say(alert)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
