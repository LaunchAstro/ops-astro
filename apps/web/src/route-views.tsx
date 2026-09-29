// SPDX-License-Identifier: AGPL-3.0-only
//
// What the manifest draws (MP-2-1): the rail and tab row for an address, the
// placeholder for a page whose ticket has not landed, and the one refusal for
// a client address the person holds no grant on. Their looks belong to MP-2-2,
// MP-2-6 and MP-2-10.

import type { ReactElement } from 'react';
import { Empty, type RailEntry } from '@launchastro/ui';
import { CROSS_FACE, SECTIONS, fill, type Page, type PageMatch } from './manifest.ts';
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
