// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// The live-correction check places the approved occurrence on the source's
// own render, but the built page drops text the source holds (a false
// conditional, a JSX comment, an island's children) and adds text it never
// shows (a layout's nav or footer). An unrendered duplicate of the typo and a
// layout copy of the replacement then line the counts up: the unchanged page
// reads live, and a still-corrected page reads reverted (catalogue #953).
// The source alone cannot close this, so the place is calibrated on the served
// page captured before dispatch: an unchanged page never reads live, and a
// revert must return to what was observed.
//
// The pre-image reaches the check as a `capture` port on `publishCorrection`
// (the served catalogued page, read before the send), and a revert is observed
// at the place the accepted outcome carries. Both are passed as plain values
// here, so the shapes the rebuild settles on are named in one place each.

import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  checkEnvelope,
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
import { occurrenceOf, showsAt } from '../../packages/core-connectors/src/site/reconcile.ts';

const published = {
  revision: 'approved-revision',
  deploymentId: 'deployment-1',
  liveUrl: 'https://physio.example/contact/',
};
const reverted = { revision: 'revert-revision', deploymentId: 'deployment-2' };
const decidedAt = Date.parse('2026-10-05T00:00:00Z');
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

/** Visible text of served HTML, as the fenced capture reads it. */
function seen(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

/** The approved occurrence is the source's first copy of the word. */
function job(target: CorrectionTarget, before: string): PublishJob {
  const after = before.replace(target.word, target.replacement);
  const pin = {
    target,
    change: { files: [{ path: target.path, before, after }] },
    preImageDigest: contentDigest(before),
    baseRevision: 'base-revision',
    pageUrl: published.liveUrl,
    seam: 'request-953',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-953',
    version: { versionId: 'version-1', digest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest: digest,
    },
  };
}

/** Publish ports with the served page before dispatch as `preImage`. */
function ports(source: string, preImage: string, raised: string[] = []) {
  const captured: string[] = [];
  const base: Omit<PublishPorts, 'capture'> = {
    readSource: async () => ({ kind: 'ok', value: { content: source, revision: 'base-revision' } }),
    readBack: async () => ({ state: 'absent' }),
    publish: async () => ({ kind: 'ok', value: published }),
    cancellation: async () => 'none',
    raiseTask: async (reason) => {
      raised.push(reason);
    },
  };
  const withPreImage = {
    ...base,
    capture: async (url: string) => {
      captured.push(url);
      return { ok: true as const, value: { text: seen(preImage) } };
    },
  };
  return { ports: withPreImage, captured };
}

async function accept(target: CorrectionTarget, source: string, preImage: string) {
  const approved = job(target, source);
  expect((await checkEnvelope(approved.change, target)).ok).toBe(true);
  const { ports: p } = ports(source, preImage);
  const outcome = await publishCorrection(approved, p);
  if (outcome.state !== 'accepted') throw new Error(`fixture was ${outcome.state}`);
  return { approved, accepted: outcome };
}

function observe(accepted: Accepted, target: CorrectionTarget, servedHtml: string) {
  return observeLanded(accepted, target, {
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: published.revision, served: true },
    }),
    capture: async () => ({ ok: true, value: { text: seen(servedHtml) } }),
  });
}

function revert(approved: PublishJob, accepted: Accepted, servedHtml: string) {
  const input = {
    publishedRevision: published.revision,
    target: approved.target,
    change: approved.change,
    seam: 'revert-953',
    decidedAt,
    occurrence: accepted.occurrence,
  };
  return revertCorrection(input, {
    now: () => decidedAt + 1000,
    readBack: async () => ({ state: 'absent' }),
    revert: async () => ({ kind: 'ok', value: reverted }),
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: reverted.revision, served: true },
    }),
    capture: async () => ({ ok: true, value: { text: seen(servedHtml) } }),
  });
}

const LAYOUT = "---\nimport Layout from '../layouts/Layout.astro';\n---\n";
const NAV_CONTACT =
  '<header><nav><a href="/">Home</a> <a href="/contact">Contact</a></nav></header>';
const NAV_TYPO = '<header><nav><a href="/">Home</a> <a href="/contact">Contcat</a></nav></header>';
const CALL = '<p>Call us on 07 5555 0100 or book online.</p>';
const aboutPage = (word: string) =>
  `<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header><main><p>We walk ${word} you.</p><p>Our clinic is open six days.</p></main>`;

it('an unchanged heading never reads live when an unrendered duplicate and a layout nav line the counts up', async () => {
  const sources = {
    conditional: `${LAYOUT}<Layout title="Acme Physio">\n<h2>Contcat</h2>\n${CALL}\n{closedForHolidays && <h2>Contcat</h2>}\n</Layout>\n`,
    'jsx comment': `${LAYOUT}<Layout title="Acme Physio">\n<h2>Contcat</h2>\n${CALL}\n{/* <h2>Contcat</h2> */}\n</Layout>\n`,
    'false literal': `${LAYOUT}<Layout>\n<h1>Contcat</h1>\n{false && <h1>Contcat</h1>}\n</Layout>\n`,
  };
  const unchanged = `${NAV_CONTACT}<main><h2>Contcat</h2>${CALL}</main>`;
  const read = async (source: string) => {
    const { accepted } = await accept(contact, source, unchanged);
    return (await observe(accepted, contact, unchanged)).state;
  };
  const states = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([name, source]) => [name, await read(source)]),
    ),
  );
  expect(states).toEqual({
    conditional: 'accepted',
    'jsx comment': 'accepted',
    'false literal': 'accepted',
  });
});

it('a still-corrected heading never reads reverted when the layout nav holds the typo', async () => {
  const source = `${LAYOUT}<Layout>\n<h2>Contcat</h2>\n${CALL}\n{showForm && <h2>Contact</h2>}\n</Layout>\n`;
  const preImage = `${NAV_TYPO}<main><h2>Contcat</h2>${CALL}</main>`;
  const stillCorrected = `${NAV_TYPO}<main><h2>Contact</h2>${CALL}</main>`;
  const { approved, accepted } = await accept(contact, source, preImage);
  expect((await revert(approved, accepted, stillCorrected)).state).toBe('revert_accepted');
});

it('an unchanged sentence never reads live when a commented copy and a layout sentence line the counts up', async () => {
  const source = `${LAYOUT}<Layout>\n<p>We walk alongside you.</p>\n{/* <p>We walk alongside you.</p> */}\n</Layout>\n`;
  const unchanged =
    '<header><p>We walk beside you.</p></header><main><p>We walk alongside you.</p></main>';
  const { accepted } = await accept(about, source, unchanged);
  expect((await observe(accepted, about, unchanged)).state).toBe('accepted');
});

it('an honest page still reads live once corrected and reverted once reverted, and the pre-image is the catalogued page', async () => {
  const source = `${LAYOUT}<Layout>\n<p>We walk alongside you.</p>\n<p>Our clinic is open six days.</p>\n</Layout>\n`;
  const approved = job(about, source);
  const { ports: p, captured } = ports(source, aboutPage('alongside'));
  const accepted = await publishCorrection(approved, p);
  if (accepted.state !== 'accepted') throw new Error(`fixture was ${accepted.state}`);
  const states = {
    unchanged: (await observe(accepted, about, aboutPage('alongside'))).state,
    corrected: (await observe(accepted, about, aboutPage('beside'))).state,
    stillCorrected: (await revert(approved, accepted, aboutPage('beside'))).state,
    reverted: (await revert(approved, accepted, aboutPage('alongside'))).state,
  };
  expect({ states, captured }).toEqual({
    states: {
      unchanged: 'accepted',
      corrected: 'live',
      stillCorrected: 'revert_accepted',
      reverted: 'reverted',
    },
    captured: [published.liveUrl],
  });
});

it('a duplicate sentence on an honest page still reads live at the approved occurrence', async () => {
  const sentence = '<p>We walk alongside you.</p>\n';
  const { accepted } = await accept(about, sentence + sentence, sentence + sentence);
  const corrected = '<p>We walk beside you.</p><p>We walk alongside you.</p>';
  expect((await observe(accepted, about, corrected)).state).toBe('live');
});

it('an unrendered duplicate and a layout nav never make the unchanged heading read live at the source place', async () => {
  const target = { path: 'src/pages/about.astro', word: 'Contcat', replacement: 'Contact' };
  const before =
    "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout>\n<h1>Contcat</h1>\n{false && <h1>Contcat</h1>}\n</Layout>\n";
  const after = before.replace('<h1>Contcat', '<h1>Contact');
  const change = { files: [{ path: target.path, before, after }] };

  expect((await checkEnvelope(change, target)).ok).toBe(true);

  const where = occurrenceOf(change, target);
  const reading = readDocument('<nav>Contact</nav><h1>Contcat</h1>');
  if (typeof reading === 'string') throw new Error(`Capture refused: ${reading}`);

  expect(showsAt(reading.text, where, 'Contact', 'Contcat')).toBe(false);

  const accepted: Accepted = {
    state: 'accepted',
    revision: 'rev-1',
    deploymentId: 'dep-1',
    liveUrl: 'https://example.test/about',
    dispatchToken: 'token-1',
    occurrence: where,
  };
  const observed = await observeLanded(accepted, target, {
    readDeployment: async () => ({ kind: 'ok', value: { revision: 'rev-1', served: true } }),
    capture: async () => ({ ok: true, value: { text: reading.text } }),
  });
  expect(observed.state).toBe('accepted');
});

it('an unchanged sentence never reads live when an equal match straddles the line before it', async () => {
  // The line before the break ends where the place's text begins, so the page's first equal
  // match spans the break and holds the replacement: the place must show the approved word.
  const line = '<p>Thank you. We walk beside<br>you. We walk alongside you.</p>';
  const source = `${LAYOUT}<Layout>\n${line}\n</Layout>\n`;
  const unchanged = `<main>${line}</main>`;
  const { accepted } = await accept(about, source, unchanged);
  expect((await observe(accepted, about, unchanged)).state).toBe('accepted');
});
