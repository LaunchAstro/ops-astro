// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's "What the run was given" (TA-09, CS-6.7) in the Agent pane's side
// column, after the granted scope: per pin its kind, its label and "pinned at
// run start", and a note ending with the short digest; "Nothing was pinned
// for this run." for a run with no pin; no section without a run. The pins are
// `task.read`'s, as the version carries them.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const PIN_DIGEST = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

const bootstrapPin = (path: string) => ({
  kind: 'bootstrap_file',
  path,
  digest: PIN_DIGEST,
  size: 42,
  readAt: '2026-09-30T10:00:00.000Z',
  definitionVersionId: null,
  pinnedAt: '2026-09-30T10:00:01.000Z',
});

const given = async (overrides: Parameters<typeof version>[0]) =>
  await pane({ lineages: [lineage({ versions: [version(overrides)] })] });

// eslint-disable-next-line max-lines-per-function -- one pane, each shape of the section
describe('MP-6-2 pinned versions', () => {
  it('MP-6-2 pinned versions: each pin shows its kind, its label and "pinned at run start", and the note ends with its short digest', async () => {
    const page = await given({ pins: [bootstrapPin('skills/brief/SKILL.md')] });
    const section = page.find('[data-agent="side"] [data-agent="given"]');
    expect(section?.querySelector('.sb__k')?.textContent).toBe('What the run was given');
    const rows = [...(section?.querySelectorAll('[data-given="pin"]') ?? [])];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.tf__k')?.textContent).toBe('Skill file');
    expect(rows[0]?.querySelector('[data-given="label"]')?.textContent).toBe(
      'skills/brief/SKILL.md',
    );
    expect(rows[0]?.textContent).toContain('pinned at run start');
    const note = section?.querySelector('[data-given="note"]')?.textContent ?? '';
    expect(note.endsWith(PIN_DIGEST.slice(0, 12))).toBe(true);
    expect(note).not.toContain(PIN_DIGEST);
  });

  it('MP-6-2 pinned versions: the section follows the granted scope in the side column', async () => {
    const page = await given({ pins: [bootstrapPin('skills/brief/SKILL.md')] });
    const scope = page.find('[data-agent="side"] [data-agent="scope"]');
    const section = page.find('[data-agent="side"] [data-agent="given"]');
    expect(section).not.toBeNull();
    const order = scope?.compareDocumentPosition(section as Node) ?? 0;
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('MP-6-2 pinned versions: a run with no pin says "Nothing was pinned for this run."', async () => {
    // An empty list, and a read made before the field existed.
    for (const overrides of [{ pins: [] }, {}]) {
      // eslint-disable-next-line no-await-in-loop -- one pane at a time
      const page = await given(overrides);
      const section = page.find('[data-agent="given"]');
      expect(section?.textContent).toContain('Nothing was pinned for this run.');
      expect(section?.querySelector('[data-given="pin"], [data-given="note"]')).toBeNull();
      // eslint-disable-next-line no-await-in-loop -- one pane at a time
      await unmountAll();
    }
  });

  it('MP-6-2 pinned versions: a version with no run has no such section', async () => {
    const page = await given({ runId: null, pins: [] });
    expect(page.find('[data-agent="given"]')).toBeNull();
  });

  it('MP-6-2 agent content inert: a pin label with markup renders as text', async () => {
    const page = await given({ pins: [bootstrapPin('<img src=x onerror="alert(1)">')] });
    const section = page.find('[data-agent="given"]');
    expect(section?.querySelector('img')).toBeNull();
    expect(section?.querySelector('[data-given="label"]')?.textContent).toBe(
      '<img src=x onerror="alert(1)">',
    );
  });
});
