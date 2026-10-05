// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// The live check reads one page: a capture that ends on another address (a
// redirect) proves nothing about the catalogued page. A correction the check
// cannot confirm is never left silent: a person is told once per intended
// effect, however often the publish or revert is retried. And an honest
// correction reads live wherever the served page puts its target among copies
// of the word (Sol PRV-oa-982-R1, catalogue #953).

import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  contentDigest,
  observeLanded,
  publishCorrection,
  revertCorrection,
  versionDigestOf,
  type Accepted,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';

const PAGE = 'https://agency.example/contact/';
const OTHER = 'https://agency.example/other/';
const published = { revision: 'rev-1', deploymentId: 'dep-1', liveUrl: PAGE };
const contact: CorrectionTarget = {
  path: 'src/pages/contact.astro',
  word: 'Contcat',
  replacement: 'Contact',
};
const about: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

function seen(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

/** The approved occurrence is the source's first copy of the word unless `after` says otherwise. */
function job(
  target: CorrectionTarget,
  before: string,
  after = before.replace(target.word, target.replacement),
): PublishJob {
  const pin = {
    target,
    change: { files: [{ path: target.path, before, after }] },
    preImageDigest: contentDigest(before),
    baseRevision: 'base',
    pageUrl: PAGE,
    seam: 'request-982',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-982',
    version: { versionId: 'v1', digest },
    decision: { decisionId: 'd1', decision: 'approve', versionId: 'v1', versionDigest: digest },
  };
}

/** A task port that keeps one task per reason and key, as the contract asks. */
function tasks() {
  const calls: string[] = [];
  const raised = new Set<string>();
  const raiseTask = async (reason: string, key?: string) => {
    calls.push(reason);
    // A call without a key could never be told from another effect's: it is its own task.
    raised.add(
      typeof key === 'string' && key !== '' ? `${reason} ${key}` : `${reason} #${calls.length}`,
    );
  };
  return { calls, raised, raiseTask };
}

function publishPorts(
  source: string,
  pre: { html: string; url: string },
  overrides: Partial<PublishPorts> = {},
): PublishPorts {
  return {
    readSource: async () => ({ kind: 'ok', value: { content: source, revision: 'base' } }),
    readBack: async () => ({ state: 'absent' }),
    publish: async () => ({ kind: 'ok', value: published }),
    cancellation: async () => 'none',
    raiseTask: async () => {},
    capture: async () => ({ ok: true, value: { text: seen(pre.html), url: pre.url } }),
    ...overrides,
  };
}

function observe(accepted: Accepted, target: CorrectionTarget, html: string, url = PAGE) {
  return observeLanded(accepted, target, {
    readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev-1', served: true } }),
    capture: async () => ({ ok: true, value: { text: seen(html), url } }),
  });
}

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

it('an honest correction reads live when an unrendered copy and a footer copy line the counts up', async () => {
  const source = '<Layout>\n{false && <h2>Contcat</h2>}\n<h2>Contcat</h2>\n</Layout>\n';
  const { raised, raiseTask } = tasks();
  const outcome = await publishCorrection(
    job(contact, source, source.replace('\n<h2>Contcat', '\n<h2>Contact')),
    publishPorts(source, { html: footerPage('Contcat'), url: PAGE }, { raiseTask }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  expect({
    unchanged: (await observe(outcome, contact, footerPage('Contcat'))).state,
    corrected: (await observe(outcome, contact, footerPage('Contact'))).state,
    raised: raised.size,
  }).toEqual({ unchanged: 'accepted', corrected: 'live', raised: 0 });
});

it('a revert at a place never seen live raises one recovery task across its attempts', async () => {
  const source = '<p>We walk alongside you.</p>\n';
  const outcome = await publishCorrection(
    job(about, source),
    publishPorts(source, { html: '<p>We walk alongside you.</p>', url: PAGE }),
  );
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  const { calls, raised, raiseTask } = tasks();
  const revert = () =>
    revertCorrection(
      {
        publishedRevision: 'rev-1',
        target: about,
        occurrence: outcome.occurrence,
        seam: 'revert-982',
        decidedAt: 0,
      },
      {
        now: () => 1000,
        readBack: async () => ({ state: 'absent' }),
        revert: async () => ({ kind: 'ok', value: { revision: 'rev-2', deploymentId: 'dep-2' } }),
        readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev-2', served: true } }),
        capture: async () => ({ ok: true, value: { text: 'We walk alongside you.', url: PAGE } }),
        raiseTask,
      },
    );
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
