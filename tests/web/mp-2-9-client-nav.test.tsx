// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-9, the client workspace sub-navigation: inside a client the rail holds
// "Back to Clients" and that client's seven sections, and the client's identity
// sits in the app strip. Looks at 1480, 900 and 390 are measured in a browser
// by `tests/browser/app-frame.mjs`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from './mp-2-1-support.tsx';
import { follow, layout, lit } from './frame-support.tsx';

let undo: () => void = () => undefined;
beforeEach(() => {
  undo = layout();
});
afterEach(() => {
  undo();
});

const SEVEN = [
  ['Overview', '/clients/acme-dental/'],
  ['Projects', '/clients/acme-dental/projects/'],
  ['Channel workbench', '/clients/acme-dental/workbench/'],
  ['Library', '/clients/acme-dental/library/brand/'],
  ['Docs', '/clients/acme-dental/docs/'],
  ['Forms', '/clients/acme-dental/forms/'],
  ['Account', '/clients/acme-dental/account/'],
] as const;

describe('MP-2-9 "Back to Clients" is a real link in the small primary dress', () => {
  it('is an anchor to the Clients board, dressed as the small primary button with a back icon', async () => {
    const { view, seen } = await open('/clients/acme-dental/library/voice/');
    const back = view.find('.rail .rail__back');
    expect(back?.tagName).toBe('A');
    expect(back?.getAttribute('href')).toBe('/clients/');
    expect(back?.className).toMatch(/\bbtn\b.*\bbtn--primary\b.*\bbtn--sm\b/u);
    expect(back?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(back?.querySelector('.rail__label')?.textContent).toBe('Back to Clients');
    await follow(view, '.rail .rail__back');
    expect(seen.at(-1)).toBe('/clients/');
    await view.unmount();
  });
});

describe('MP-2-9 seven sections', () => {
  it("lists the client's seven sections with its slug, in order", async () => {
    const { view } = await open('/clients/acme-dental/');
    const drawn = view
      .all('.rail .rail__item')
      .map((a) => [a.textContent?.trim(), a.getAttribute('href')]);
    expect(drawn).toEqual(SEVEN.map(([label, href]) => [label, href]));
    await view.unmount();
  });
});

describe('MP-2-9 CS-2.10 back link and the seven sections, current one lit', () => {
  it('lights the section the page sits in', async () => {
    const { view } = await open('/clients/acme-dental/account/plan/');
    expect(lit(view)).toEqual(['Account']);
    await view.unmount();
  });

  it('keeps an icon and a name on the back link for the collapsed rail', async () => {
    const { view } = await open('/clients/acme-dental/');
    const back = view.find('.rail .rail__back');
    expect(back?.getAttribute('title')).toBe('Back to Clients');
    await view.unmount();
  });
});

describe("MP-2-9 the client's identity sits in the strip", () => {
  it("shows the client's mark and name in the app strip on a workspace page", async () => {
    const { view } = await open('/clients/acme-dental/projects/');
    expect(view.find('.appbar .clienthdr__mark')?.textContent).toBe('A');
    expect(view.find('.appbar .clienthdr__name')?.textContent).toBe('Acme Dental');
    expect(view.find('.appbar .clienthdr__tag')?.textContent).toBe('Agency view');
    await view.unmount();
  });
});
