// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// A correction or revert the check cannot confirm is never left silent: a
// person is told once per intended effect, however often it is retried. The
// check confirms only the change at the calibrated place; a page changed any
// other way is a person's to read (catalogue #953, #981).

import { expect, it } from 'vitest';
import { publishCorrection } from '../../packages/core-connectors/src/index.ts';
import {
  PAGE,
  about,
  contact,
  job,
  observe,
  publishPorts,
  published,
  revertAt,
  tasks,
} from './live-check-world.ts';

it('concurrent retries of one landed publish raise one recovery task between them', async () => {
  const source = '<p>We walk alongside you.</p>\n';
  const { calls, raised, raiseTask } = tasks();
  const ports = publishPorts(
    source,
    { html: '<p>We walk alongside you.</p>', url: PAGE },
    { readBack: async () => ({ state: 'landed', value: published }), raiseTask },
  );
  const approved = job(about, source);
  const attempts = [1, 2, 3].map(async () => await publishCorrection(approved, ports));
  const states = (await Promise.all(attempts)).map((outcome) => outcome.state);
  expect({ states, calls: calls.length, tasks: raised.size }).toEqual({
    states: ['accepted', 'accepted', 'accepted'],
    calls: 3,
    tasks: 1,
  });
});

const footerPage = (heading: string) =>
  `<main><h2>${heading}</h2></main><footer><a>Contcat</a></footer>`;

it('a correction that changes a copy other than its calibrated place is never certified and raises one recovery task', async () => {
  const source = '<Layout>\n{false && <h2>Contcat</h2>}\n<h2>Contcat</h2>\n</Layout>\n';
  const { calls, raised, raiseTask } = tasks();
  const outcome = await publishCorrection(
    job(contact, source, source.replace('\n<h2>Contcat', '\n<h2>Contact')),
    publishPorts(source, { html: footerPage('Contcat'), url: PAGE }, { raiseTask }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const read = async (heading: string) =>
    (await observe(outcome, contact, footerPage(heading), PAGE, raiseTask)).state;
  expect({
    unchanged: await read('Contcat'),
    corrected: [await read('Contact'), await read('Contact')],
    calls: calls.length,
    tasks: [...raised].map((task) => task.split(' ')[0]),
  }).toEqual({
    unchanged: 'accepted',
    corrected: ['accepted', 'accepted'],
    calls: 2,
    tasks: ['LIVE_CHECK_UNCONFIRMED'],
  });
});

const islandPage = (comment: string) =>
  `<main><astro-island client="only"></astro-island><section><h2>Contcat</h2></section><div class="comments"><p>${comment}</p></div></main>`;

it('a copy of the word changing elsewhere never reads live while the target never renders', async () => {
  const source =
    '<Layout>\n<Form client:only="react"><h2>Contcat</h2></Form>\n<section><h2>Contcat</h2></section>\n<Comments />\n</Layout>\n';
  const { raised, raiseTask } = tasks();
  const outcome = await publishCorrection(
    job(contact, source),
    publishPorts(source, { html: islandPage('Contcat'), url: PAGE }, { raiseTask }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  expect({
    placed: outcome.occurrence !== undefined,
    edited: (await observe(outcome, contact, islandPage('Contact'), PAGE, raiseTask)).state,
    tasks: [...raised].map((task) => task.split(' ')[0]),
  }).toEqual({ placed: true, edited: 'accepted', tasks: ['LIVE_CHECK_UNCONFIRMED'] });
});

it('a revert at a place never seen live raises one recovery task across its attempts', async () => {
  const source = '<p>We walk alongside you.</p>\n';
  const outcome = await publishCorrection(
    job(about, source),
    publishPorts(source, { html: '<p>We walk alongside you.</p>', url: PAGE }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const { calls, raised, raiseTask } = tasks();
  const revert = () => revertAt(outcome.occurrence, 'We walk alongside you.', PAGE, raiseTask);
  const states = [(await revert()).state, (await revert()).state];
  expect({
    states,
    calls: calls.length,
    tasks: [...raised].map((task) => task.split(' ')[0]),
  }).toEqual({
    states: ['revert_accepted', 'revert_accepted'],
    calls: 2,
    tasks: ['REVERT_CHECK_UNPLACED'],
  });
});

it('a page where two equal copies changed never reads live and raises a recovery task', async () => {
  const sentence = '<p>We walk alongside you.</p>\n';
  const source = sentence + sentence;
  const outcome = await publishCorrection(
    job(about, source),
    publishPorts(source, {
      html: '<p>We walk alongside you.</p><p>We walk alongside you.</p>',
      url: PAGE,
    }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const { raised, raiseTask } = tasks();
  const read = async (html: string) => (await observe(outcome, about, html, PAGE, raiseTask)).state;
  expect({
    both: await read('<p>We walk beside you.</p><p>We walk beside you.</p>'),
    one: await read('<p>We walk beside you.</p><p>We walk alongside you.</p>'),
    tasks: [...raised].map((task) => task.split(' ')[0]),
  }).toEqual({ both: 'accepted', one: 'live', tasks: ['LIVE_CHECK_UNCONFIRMED'] });
});

it('a revert that changes a copy other than the place seen live raises a recovery task', async () => {
  const sentence = '<p>We walk alongside you.</p>\n';
  const source = sentence + sentence;
  const outcome = await publishCorrection(
    job(about, source),
    publishPorts(source, {
      html: '<p>We walk alongside you.</p><p>We walk alongside you.</p>',
      url: PAGE,
    }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const live = await observe(
    outcome,
    about,
    '<p>We walk beside you.</p><p>We walk alongside you.</p>',
  );
  const { raised, raiseTask } = tasks();
  const revert = (text: string) => revertAt(live.occurrence, text, PAGE, raiseTask);
  expect({
    live: live.state,
    stillCorrected: (await revert('We walk beside you. We walk alongside you.')).state,
    elsewhere: (await revert('We walk beside you. We walk beside you.')).state,
    reverted: (await revert('We walk alongside you. We walk alongside you.')).state,
    tasks: [...raised].map((task) => task.split(' ')[0]),
  }).toEqual({
    live: 'live',
    stillCorrected: 'revert_accepted',
    elsewhere: 'revert_accepted',
    reverted: 'reverted',
    tasks: ['REVERT_CHECK_UNCONFIRMED'],
  });
});
