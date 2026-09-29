// SPDX-License-Identifier: AGPL-3.0-only
//
// What the manifest draws (MP-2-1): the rail and tab row for an address, with
// the section lit (MP-2-2, MP-2-6, MP-2-9), the client in the strip, the one
// shared state for a page not built yet (MP-2-10), and the one refusal for a
// client address the person holds no grant on.

import type { ReactElement } from 'react';
import type { RailEntry, StripClient, TabEntry } from '@launchastro/ui';
import { CROSS_FACE, SECTIONS, fill, type Page, type PageMatch, type Section } from './manifest.ts';
import type { RouteMatch } from './routes.ts';
import { RecordState } from './views/record-state.tsx';

/**
 * Built screens that are not manifest pages, and the rail section each sits
 * in, so the current section is lit on every address (MP-2-2).
 */
const SECTION_OF_ROUTE: Readonly<Record<string, string>> = {
  'agency:task-detail': 'agency:projects',
};

const namespaceSections = (namespace: Section['namespace']): readonly Section[] =>
  SECTIONS.filter((each) => each.namespace === namespace && each.navigable);

/**
 * The rail section the address sits in: the one holding its manifest page; for
 * a built screen outside the manifest, the one it is declared under; for a
 * utility page such as the booking page, the section whose page addresses are
 * the longest start of it.
 */
export function sectionAt(at: PageMatch | null, route: RouteMatch | null): Section | null {
  const declared = route === null ? undefined : SECTION_OF_ROUTE[route.id];
  if (declared !== undefined) {
    return SECTIONS.find((each) => `${each.namespace}:${each.id}` === declared) ?? null;
  }
  if (at === null) return null;
  const holder = namespaceSections(at.page.namespace).find((each) => each.pages.includes(at.page));
  if (holder !== undefined) return holder;
  const address = fill(at.page.path, at.client);
  let best: { readonly section: Section; readonly length: number } | null = null;
  for (const section of namespaceSections(at.page.namespace)) {
    for (const page of section.tabs) {
      const path = fill(page.path, at.client);
      if (address.startsWith(path) && path.length > (best?.length ?? 0)) {
        best = { section, length: path.length };
      }
    }
  }
  return best?.section ?? null;
}

/** A refused address gets no rail: one naming another client would say what the refusal hides. */
export function railFor(
  at: PageMatch | null,
  refused: boolean,
  lit: Section | null = null,
  here = '',
): readonly RailEntry[] {
  if (refused) return [];
  const namespace = lit?.namespace ?? at?.page.namespace ?? 'agency';
  const rail = namespaceSections(namespace).map((each): RailEntry => {
    const href = fill(each.path, at?.client ?? null);
    const lights = each === lit;
    return {
      id: `${namespace}:${each.id}`,
      label: each.label,
      href,
      lit: lights,
      exact: lights && href === here,
    };
  });
  const back = CROSS_FACE.find(([from, to]) => from === 'clients' && to === 'agency');
  return namespace === 'clients' && back !== undefined
    ? [{ id: 'clients:back', label: 'Back to Clients', href: back[2], kind: 'back' }, ...rail]
    : rail;
}

/** The current section's designed pages as tabs, or null for a section with one. */
export function tabsFor(
  at: PageMatch | null,
  section: Section | null,
): { readonly id: string; readonly label: string; readonly entries: readonly TabEntry[] } | null {
  if (at === null || section === null || section.tabs.length < 2) return null;
  return {
    id: `${section.namespace}:${section.id}`,
    label: section.label,
    entries: section.tabs.map((each) => ({
      id: each.id,
      label: each.label,
      href: fill(each.path, at.client),
      current: each === at.page,
    })),
  };
}

/**
 * The client's identity for the app strip, from the address's slug. Client
 * records arrive with MP-10-1; until then the slug is the only name held, so it
 * is shown in words, and only for a client the person may open.
 */
export function stripClient(slug: string | null): StripClient | null {
  if (slug === null) return null;
  const name = decodeURIComponent(slug)
    .split('-')
    .filter((word) => word !== '')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
  return name === '' ? null : { mark: name.slice(0, 1), name };
}

/**
 * The one shared state for a page not built yet, typed or followed: no
 * placeholder page, no sibling cards and no ticket in its words (R2). Which
 * page and ticket it stands for stay on it for the record.
 */
export const PagePlaceholder = (props: { readonly page: Page }): ReactElement => (
  <div
    className="readstate"
    data-outcome="placeholder"
    data-page={props.page.id}
    data-ticket={props.page.ticket}
  >
    <div className="empty" data-voice="not-built">
      <p className="empty__title">Not here yet</p>
      <p className="empty__desc">This page isn&apos;t built yet.</p>
    </div>
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
