// SPDX-License-Identifier: AGPL-3.0-only
//
// What the manifest draws (MP-2-1): the rail and tab row for an address, the
// placeholder for a page whose ticket has not landed, the one refusal for
// a client address the person holds no grant on, and the answer for an address
// nothing resolves. Their looks belong to MP-2-2, MP-2-6 and MP-2-10.

import type { ReactElement } from 'react';
import { Empty, type RailEntry } from '@launchastro/ui';
import { CROSS_FACE, SECTIONS, fill, isLegacy, type Page, type PageMatch } from './manifest.ts';
import { pathTo } from './routes.ts';
import { RecordState } from './views/record-state.tsx';

/** A refused address gets no rail: one naming another client would say what the refusal hides. */
export function railFor(at: PageMatch | null, refused: boolean): readonly RailEntry[] {
  if (refused) return [];
  const namespace = at?.page.namespace ?? 'agency';
  const rail = SECTIONS.filter((each) => each.namespace === namespace).map((each) => ({
    id: `${namespace}:${each.id}`,
    label: each.label,
    href: fill(each.path, at?.client ?? null),
  }));
  const back = CROSS_FACE.find(([from, to]) => from === 'clients' && to === 'agency');
  return namespace === 'clients' && back !== undefined
    ? [{ id: 'clients:back', label: 'Back to Clients', href: back[2] }, ...rail]
    : rail;
}

export function RouteTabs(props: { readonly at: PageMatch }): ReactElement | null {
  const section = SECTIONS.find((each) => each.pages.includes(props.at.page));
  if (section === undefined || section.pages.length < 2) return null;
  return (
    <nav className="routetabs" data-tabs="route" aria-label={section.label}>
      {section.pages.map((each) => (
        <a
          key={each.id}
          href={fill(each.path, props.at.client)}
          aria-current={each === props.at.page ? 'page' : undefined}
        >
          {each.label}
        </a>
      ))}
    </nav>
  );
}

export const PagePlaceholder = (props: { readonly page: Page }): ReactElement => (
  <div className="readstate" data-outcome="placeholder" data-page={props.page.id}>
    <Empty title={props.page.label} description={`This page is built by ${props.page.ticket}.`} />
  </div>
);

/** Another business's client, an ungranted one and a missing one all read the same. */
export const ClientRefused = (): ReactElement => (
  <RecordState
    subject="page"
    state={{
      outcome: 'denied',
      value: null,
      refusal: { refused: true, code: 'NOT_FOUND', names: [], fixes: [] },
      because: null,
      grantKey: 'refused',
    }}
  >
    {() => null}
  </RecordState>
);

// An unknown legacy address is not echoed: no legacy address reaches the interface (R5).
export function NotFound(props: { readonly path: string }): ReactElement {
  return (
    <div className="readstate" data-outcome="not-found">
      <p className="empty__title">
        No screen is registered at {isLegacy(props.path) ? 'this address' : props.path}.
      </p>
      <p className="empty__desc">
        The route registry is the list the application resolves through. An address that is not in
        it does not resolve, which is a truer answer than a blank page.
      </p>
      <p className="empty__hint">
        <a className="sb__addr" href={pathTo('agency:projects-board')}>
          Go to Projects
        </a>
      </p>
    </div>
  );
}
