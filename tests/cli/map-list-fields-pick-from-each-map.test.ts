// SPDX-License-Identifier: AGPL-3.0-only
//
// `map list` answers `{ ok, maps: [...] }`: a list under one key, not a page.
// `--fields` picks from each map, as it picks from each page item, never from
// the list itself. A stand-in transport answers; no database and no API.

import { describe, expect, it } from 'vitest';
import { createVerbCli } from '../../apps/cli/verbs.ts';

const MAPS = [
  { id: 'map-1', key: 'OA-1', title: 'Plan the new agency website' },
  { id: 'map-2', key: null, title: 'Second map' },
];

const cli = createVerbCli({
  businessKey: 'alpha',
  credential: 'made-up',
  transport: () => Promise.resolve(Response.json({ ok: true, maps: MAPS })),
});

describe('map list answers one entry per map', () => {
  it('--fields keeps the named fields of every map', async () => {
    const answer = await cli.run(['map', 'list', '--fields', 'id,title', '--json']);
    expect(answer.exit, answer.out).toBe(0);
    expect(JSON.parse(answer.out)).toStrictEqual([
      { id: 'map-1', title: 'Plan the new agency website' },
      { id: 'map-2', title: 'Second map' },
    ]);
  });

  it('with no --fields, --json prints every map whole', async () => {
    const answer = await cli.run(['map', 'list', '--json']);
    expect(answer.exit, answer.out).toBe(0);
    expect(JSON.parse(answer.out)).toStrictEqual(MAPS);
  });

  it('as text, prints one line per map', async () => {
    const answer = await cli.run(['map', 'list', '--fields', 'key,title']);
    expect(answer.exit, answer.out).toBe(0);
    expect(answer.out.split('\n')).toStrictEqual([
      'OA-1 | Plan the new agency website',
      '- | Second map',
    ]);
  });
});
