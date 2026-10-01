// SPDX-License-Identifier: AGPL-3.0-only
//
// The captures ask `screenOf` which screen the app drew. The enrolment page
// (C39-T) borrows the sign-in form's classes for its look, so a check on those
// classes alone called it the sign-in form, and every enrolment capture failed
// as a page that fell to sign-in. The sign-in screen is told apart by its own
// mark, and is still caught where it draws.

// @ts-expect-error -- jsdom ships no declarations; this proof only reads its DOM document
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { Enrol } from '../../apps/web/src/screens/Enrol.tsx';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import { screenOf } from './app-pages.ts';

function drawn(markup: string): string {
  const dom = new JSDOM(`<div id="app">${markup}</div>`);
  vi.stubGlobal('document', dom.window.document);
  try {
    return screenOf();
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
}

const noFetch = (async () => {
  throw new Error('no request in a static draw');
}) as unknown as typeof globalThis.fetch;

it('the enrolment form is the page, and the sign-in form is still the sign-in form', () => {
  const enrol = renderToStaticMarkup(
    <Enrol
      token="made-up-enrolment-link"
      app={{ apiOrigin: '', fetch: noFetch, navigate: () => {} }}
    />,
  );
  // The enrolment page wears the sign-in form's classes: the case this guards.
  expect(enrol).toContain('signin__form');
  expect(drawn(enrol)).toBe('the page');

  const signIn = renderToStaticMarkup(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={noFetch}
      onSignedIn={() => {}}
      ended={null}
    />,
  );
  expect(drawn(signIn)).toBe('the sign-in form');
});
