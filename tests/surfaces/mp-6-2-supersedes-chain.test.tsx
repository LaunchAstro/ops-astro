// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's supersedes chain (TA-05, ruling (b)1 of 30 Sep): the artefact is
// the proposal the run staged, titled by its purpose, and its versions are the
// proposal versions `task.read` carries, newest first. Each version row draws
// "vN · current" for the version nothing superseded, its short digest (the
// whole one on hover), "supersedes vN" for the version before it, and the
// checks recorded on it as its evidence bullets.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import type { RunCheck } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const D1 = '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777000088889999';
const D2 = '2222bbbb3333cccc4444dddd5555eeee6666ffff777700008888999911112222';
const D3 = '3333cccc4444dddd5555eeee6666ffff7777000088889999aaaabbbbccccdddd';

const check = (id: string, name: string, outcome: string): RunCheck => ({
  id,
  name,
  outcome,
  note: null,
  performedByActorId: 'agent-1',
  recordedAt: '2026-09-30T10:00:00.000Z',
});

const withVersions = async (versions: readonly ReturnType<typeof version>[]) =>
  await pane({ lineages: [lineage({ versions })] });

const rowsOf = (page: Awaited<ReturnType<typeof withVersions>>) =>
  page.all('[data-agent="evidence"] [data-evidence="version"]').map((row) => ({
    label: row.querySelector('.tf__k')?.textContent,
    meta: row.querySelector('.sbact__meta')?.textContent,
    digest: row.querySelector('.sbact__meta')?.getAttribute('title'),
    bullets: [...row.querySelectorAll('li')].map((li) => li.textContent),
  }));

const chain = [
  version({ versionId: 'v-3', version: 3, payloadDigest: D3 }),
  version({ versionId: 'v-2', version: 2, payloadDigest: D2, supersededAt: '2026-09-30T09:00Z' }),
  version({ versionId: 'v-1', version: 1, payloadDigest: D1, supersededAt: '2026-09-30T08:00Z' }),
];

// eslint-disable-next-line max-lines-per-function -- one fixture chain, each line of TA-05 on it
describe('MP-6-2 supersedes chain', () => {
  it('MP-6-2 supersedes chain: each version newest first, the current one named, its short digest and the version it supersedes', async () => {
    const page = await withVersions(chain);
    expect(rowsOf(page).map(({ label, meta, digest }) => ({ label, meta, digest }))).toStrictEqual([
      { label: 'v3 · current', meta: '3333cccc4444 · supersedes v2', digest: D3 },
      { label: 'v2', meta: '2222bbbb3333 · supersedes v1', digest: D2 },
      { label: 'v1', meta: '1111aaaa2222', digest: D1 },
    ]);
  });

  it('MP-6-2 supersedes chain: the artefact is the proposal, titled by its purpose', async () => {
    const page = await withVersions(chain);
    const head = page.find('[data-agent="evidence"] [data-evidence="artefact"]');
    expect(head?.querySelector('.tf__k')?.textContent).toBe('Proposal');
    expect(head?.querySelector('.sout__t')?.textContent).toBe('draft the reply');
  });

  it('MP-6-2 supersedes chain: each version’s checks are its evidence bullets, and a version with none has no list', async () => {
    const [v3, v2, v1] = chain;
    const page = await withVersions([
      { ...v3!, checks: [check('c1', 'tone matches the brief', 'passed')] },
      {
        ...v2!,
        checks: [
          check('c2', 'figures reconcile', 'failed'),
          check('c3', 'names spelt right', 'inconclusive'),
        ],
      },
      v1!,
    ]);
    expect(rowsOf(page).map((row) => row.bullets)).toStrictEqual([
      ['tone matches the brief passed'],
      ['figures reconcile failed', 'names spelt right inconclusive'],
      [],
    ]);
    const lists = page.all('[data-evidence="version"] ul');
    expect(lists).toHaveLength(2);
  });

  it('MP-6-2 supersedes chain: a single version is current and supersedes nothing', async () => {
    const page = await withVersions([version({ payloadDigest: D1 })]);
    expect(rowsOf(page)).toStrictEqual([
      { label: 'v1 · current', meta: '1111aaaa2222', digest: D1, bullets: [] },
    ]);
  });

  it('MP-6-2 agent content inert: a check name with markup is drawn as text in the evidence bullets', async () => {
    const planted = '<img src=x onerror="globalThis.ran=1"><b>bold</b>';
    const page = await withVersions([
      version({ checks: [check('c1', planted, 'passed')], payloadDigest: D1 }),
    ]);
    const bullet = page.find('[data-evidence="version"] li');
    expect(bullet?.textContent).toBe(`${planted} passed`);
    expect(page.find('[data-agent="evidence"] img')).toBeNull();
    expect(page.find('[data-agent="evidence"] b')).toBeNull();
  });
});
