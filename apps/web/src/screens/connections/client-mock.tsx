// SPDX-License-Identifier: AGPL-3.0-only
//
// Sections 011 Channels and 012 Exceptions for the chosen client, drawn from
// made-up rows until MP-14-10b builds their reads (MOCK-BY-1PM). The rows sit
// inside the kit's one mock region, so nobody reads them as this client's
// records; their controls are drawn disabled, because nothing behind them
// exists yet. The rows follow the mockup's channels and exceptions.

import type { ReactElement } from 'react';
import { MockRegion } from '@launchastro/ui';

const NOT_BUILT = 'Not built yet (MP-14-10b).';

const CHANNELS = [
  {
    id: 'ch-ads',
    name: 'Google Ads',
    where: 'Account 481-220-9913',
    exec: 'Granted to write',
    state: ['is-ok', 'Verified'],
    used: 'Last used 03:41 by the night round',
    note: 'Pauses and negative keywords only, inside the standing approvals above.',
  },
  {
    id: 'ch-gbp',
    name: 'Google Business Profile',
    where: 'One location',
    exec: 'Not granted to write',
    state: ['is-warn', 'Not checked this week'],
    used: 'Never used',
    note: 'Drafts only: every post still waits for a person.',
  },
] as const;

const EXCEPTIONS = [
  {
    id: 'ex-1',
    what: 'Missing meta description',
    where: '/privacy/',
    scope: 'This page',
    why: 'The client wants the privacy page kept out of search snippets.',
    meta: ['Written by Nathan, 12 Aug', 'seo.meta.description', 'Review 12 Nov'],
  },
  {
    id: 'ex-2',
    what: 'Slow largest paint',
    where: '/gallery/',
    scope: 'This page',
    why: 'Full-size before and after photos are the point of the page.',
    meta: ['Written by Mia, 03 Sep', 'perf.lcp', 'No review date'],
  },
] as const;

export function ChannelsMock(): ReactElement {
  return (
    <MockRegion word>
      <div className="card card--flush">
        <div className="chan">
          {CHANNELS.map((one) => (
            <div className="chan__row" key={one.id} data-chan={one.id}>
              <div className="chan__head">
                <div className="chan__name">
                  <b>{one.name}</b>
                  <span className="chan__where">{one.where}</span>
                </div>
                <span className="chip chip--outline is-idle">{one.exec}</span>
                <span className={`chip chip--outline ${one.state[0]}`}>{one.state[1]}</span>
              </div>
              <div className="chan__act">
                <button type="button" className="btn btn--sm btn--ghost" disabled title={NOT_BUILT}>
                  Verify
                </button>
              </div>
              <div className="chan__meta">{one.used}</div>
              <p className="chan__note">{one.note}</p>
            </div>
          ))}
        </div>
      </div>
    </MockRegion>
  );
}

export function ExceptionsMock(): ReactElement {
  return (
    <MockRegion word>
      <div className="card card--flush">
        <div className="exc">
          {EXCEPTIONS.map((one) => (
            <div className="exc__row" key={one.id} data-exc={one.id}>
              <div className="exc__head">
                <div className="exc__what">
                  <b>{one.what}</b>
                  <span className="exc__where">{one.where}</span>
                </div>
                <span className="chip chip--outline is-idle">{one.scope}</span>
              </div>
              <div className="exc__act">
                <button type="button" className="btn btn--sm btn--ghost" disabled title={NOT_BUILT}>
                  Start flagging again
                </button>
              </div>
              <p className="exc__why">{one.why}</p>
              <div className="exc__meta">
                {one.meta.map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </MockRegion>
  );
}
