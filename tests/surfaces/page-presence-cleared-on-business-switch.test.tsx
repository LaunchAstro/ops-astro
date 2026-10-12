// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The app strip's "also on this page" faces belong to the business and person
// that read them. The provider sits above every page, so on a switch the next
// owner's first drawing must already show nobody, not the previous page's
// viewers until that page's cleanup runs a moment later.

import { useLayoutEffect, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { PresenceView } from '../../apps/web/src/data/presence.ts';
import {
  PagePresenceProvider,
  StripPresence,
  useShowOnPage,
} from '../../apps/web/src/views/presence.tsx';
import { mount, type Mounted } from './mount.tsx';

const ANA: PresenceView = { personId: 'p-ana', name: 'Ana Alpha', state: 'viewing', field: null };
const NOBODY: readonly PresenceView[] = [];

const pages: Mounted[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.unmount()));
});

function Page(props: { readonly seen: readonly PresenceView[] }): null {
  useShowOnPage(props.seen);
  return null;
}

/** What the strip holds the moment each drawing reaches the page, before passive effects run. */
function Drawn(props: { readonly into: (string | null)[] }): null {
  useLayoutEffect(() => {
    props.into.push(document.querySelector('[data-presence="page"]')?.textContent ?? null);
  });
  return null;
}

function Frame(props: {
  readonly owner: string;
  readonly seen: readonly PresenceView[];
  readonly into: (string | null)[];
}): ReactElement {
  return (
    <PagePresenceProvider owner={props.owner}>
      <StripPresence />
      <Page key={props.owner} seen={props.seen} />
      <Drawn into={props.into} />
    </PagePresenceProvider>
  );
}

it('a business switch draws the strip with nobody from its first drawing', async () => {
  const drawn: (string | null)[] = [];
  const page = await mount(<Frame owner="alpha:mia" seen={[ANA]} into={drawn} />);
  pages.push(page);
  expect(page.find('[data-presence="page"]')?.textContent).toBe('AA');
  drawn.length = 0;
  await page.render(<Frame owner="bravo:mia" seen={NOBODY} into={drawn} />);
  expect(drawn[0]).toBeNull();
  expect(page.find('[data-presence="page"]')).toBeNull();
});

it('the same owner keeps its page viewers drawn', async () => {
  const drawn: (string | null)[] = [];
  const page = await mount(<Frame owner="alpha:mia" seen={[ANA]} into={drawn} />);
  pages.push(page);
  await page.render(<Frame owner="alpha:mia" seen={[ANA]} into={drawn} />);
  expect(drawn.at(-1)).toBe('AA');
});
