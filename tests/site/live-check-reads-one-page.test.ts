// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// The live check reads one page: a capture that ends on another address (a
// redirect) proves nothing about the catalogued page, before the send, after
// it, or on a revert (catalogue #953).

import { expect, it } from 'vitest';
import { publishCorrection } from '../../packages/core-connectors/src/index.ts';
import {
  OTHER,
  PAGE,
  about,
  contact,
  job,
  observe,
  publishPorts,
  revertAt,
  tasks,
} from './live-check-world.ts';

const twoHeadings = '<Layout>\n<h2>Contcat</h2>\n{false && <h2>Contcat</h2>}\n</Layout>\n';

it('a pre-image capture redirected to another page takes no place and raises a recovery task', async () => {
  const { raised, raiseTask } = tasks();
  const outcome = await publishCorrection(
    job(contact, twoHeadings),
    publishPorts(
      twoHeadings,
      { html: '<h2>Contcat</h2><h2>Contcat</h2>', url: OTHER },
      { raiseTask },
    ),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const unchanged = '<nav>Contact</nav><main><h2>Contcat</h2></main>';
  expect({
    placed: outcome.occurrence !== undefined,
    raised: [...raised].map((task) => task.split(' ')[0]),
    observed: (await observe(outcome, contact, unchanged)).state,
  }).toEqual({ placed: false, raised: ['LIVE_CHECK_UNPLACED'], observed: 'accepted' });
});

it('a live capture redirected to another page never reads live', async () => {
  const source = '<p>We walk alongside you.</p>\n';
  const outcome = await publishCorrection(
    job(about, source),
    publishPorts(source, { html: '<p>We walk alongside you.</p>', url: PAGE }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const corrected = '<p>We walk beside you.</p>';
  expect({
    redirected: (await observe(outcome, about, corrected, OTHER)).state,
    onPage: (await observe(outcome, about, corrected)).state,
  }).toEqual({ redirected: 'accepted', onPage: 'live' });
});

it('a revert capture redirected to another page never reads reverted', async () => {
  const source = '<p>We walk alongside you.</p>\n';
  const outcome = await publishCorrection(
    job(about, source),
    publishPorts(source, { html: '<p>We walk alongside you.</p>', url: PAGE }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const live = await observe(outcome, about, '<p>We walk beside you.</p>');
  const revert = (url: string) => revertAt(live.occurrence, 'We walk alongside you.', url);
  expect({
    live: live.state,
    redirected: (await revert(OTHER)).state,
    onPage: (await revert(PAGE)).state,
  }).toEqual({ live: 'live', redirected: 'revert_accepted', onPage: 'reverted' });
});
