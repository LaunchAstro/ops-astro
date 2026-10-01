// SPDX-License-Identifier: AGPL-3.0-only
//
// What the manifest draws (MP-2-1): the rail and tab row for an address, the
// placeholder for a page whose ticket has not landed, the one refusal for
// a client address the person holds no grant on, and the answer for an address
// nothing resolves. Their looks belong to MP-2-2, MP-2-6 and MP-2-10.

import type { ReactElement } from 'react';
import { Chip, Empty, type RailEntry } from '@launchastro/ui';
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

/**
 * A held address: the page is in the manifest and not built yet. The mockup's
 * reserved-route placeholder keeps its page head (the route's label, and the
 * chip below in the topbar); its body is the one empty state (DS-PRIM-28),
 * since the placeholder page itself was retired (DS-COMP-36, R2 (a)).
 */
export const PagePlaceholder = (props: { readonly page: Page }): ReactElement => (
  <div className="readstate" data-outcome="placeholder" data-page={props.page.id}>
    <Empty
      title={`${props.page.label} is not built yet.`}
      description={`Its address is held for it. It is built by ${props.page.ticket}.`}
    />
  </div>
);

/** The page head's meta: who is signed in, and a held address's mark (the mockup's chip). */
export const TopbarMeta = (props: {
  readonly session: { readonly email: string; readonly businessKey: string };
  readonly held: boolean;
  readonly onSignOut: () => void;
}): ReactElement => (
  <>
    {props.held ? <Chip kind="outline">Not built yet</Chip> : null}
    <span className="topbar__who">
      {props.session.email} · {props.session.businessKey}
      <button className="btn" type="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </span>
  </>
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
      <Empty
        title={`No screen is registered at ${isLegacy(props.path) ? 'this address' : props.path}.`}
        description="The route registry is the list the application resolves through. An address that is not in it does not resolve, which is a truer answer than a blank page."
        action={
          <a className="sb__addr" href={pathTo('agency:projects-board')}>
            Go to Projects
          </a>
        }
      />
    </div>
  );
}

/** A signed-in person at `/sign-in`: the one empty state, with the way on. */
export function SignedInAlready(props: { readonly onGo: () => void }): ReactElement {
  return (
    <div className="readstate" data-outcome="ready">
      <Empty
        title="You are already signed in."
        action={
          <button className="btn btn--primary" type="button" onClick={props.onGo}>
            Go to Projects
          </button>
        }
      />
    </div>
  );
}
