// SPDX-License-Identifier: AGPL-3.0-only
//
// SL12's legs on the width-and-theme harness (MP-1-7), in a real browser at
// 1480, 900 and 390, light and dark, from the made-up reads (made-up-api.ts,
// made-up-agent.ts). The harness captures draw the task page's agent section
// as each ticket names it and prove each picture inside its width and dark
// unlike light; the visual matches hold each ticket's look probes
// (tests/visual/look/agent-pane.ts and conversation.ts) to the values pinned
// from the mockup. A missing browser fails these, never skips them.
/* oxlint-disable no-await-in-loop -- widths and themes run one browser context
   at a time, in order. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import type { InternalTaskRead } from '../../packages/core-wire/src/index.ts';
import { pathOf, PREFIX } from '../../packages/core-wire/src/index.ts';
import { madeUpSession, serveApp } from '../visual/app-pages.ts';
import { load, openSide, shoot } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { scrollMetrics } from '../visual/drift.ts';
import { answerMadeUp, madeUpAnswer } from '../visual/made-up-api.ts';
import { fetchAssets, MODE, readAssets, readPacket, type Theme } from '../visual/packet.ts';
import { addressOf } from '../visual/report.ts';
import { PAGE_PARAMS } from '../visual/app-pages.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const WIDTHS = [1480, 900, 390] as const;
const THEMES: readonly Theme[] = ['light', 'dark'];

/** One look screen's lines, `ok|red <probe>@<width>-<theme>...`, from look.ts. */
function lookLines(screen: string): string[] {
  const out = mkdtempSync(join(tmpdir(), 'look-'));
  try {
    const run = spawnSync(
      process.execPath,
      ['tests/visual/look.ts', '--screen', screen, '--out', out],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 540_000,
      },
    );
    if (run.error !== undefined) throw run.error;
    return run.stdout.split('\n').filter((line) => /^(ok|red) /u.test(line));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A ticket's probes hold at every width and theme: none red, each place present. */
function holds(lines: readonly string[], prefix: string, probes: number): void {
  const mine = lines.filter((line) => line.split(' ')[1]?.startsWith(prefix));
  expect(
    mine.filter((line) => line.startsWith('red ')),
    prefix,
  ).toEqual([]);
  expect(mine.length, `${prefix} lines`).toBeGreaterThanOrEqual(probes * 2);
  for (const width of WIDTHS)
    for (const theme of THEMES)
      expect(
        mine.some((line) => line.includes(`@${String(width)}-${theme}`)),
        `${prefix} at ${String(width)}-${theme}`,
      ).toBe(true);
}

describe('SL12 visual matches against the pinned mockup (MP-1-7)', () => {
  let pane: string[] = [];
  let conversation: string[] = [];
  beforeAll(() => {
    pane = lookLines('agent-pane');
    conversation = lookLines('conversation');
  }, 600_000);

  it('MP-6-1 visual match: the staged box and the armed gate on the task page (Agent) at 1480, 900 and 390, light and dark', () => {
    holds(pane, 'agent-pane.mp-6-1.', 3);
  });

  it('MP-6-5 visual match: the token panel on the over-allowance task at 1480, 900 and 390, light and dark', () => {
    holds(pane, 'agent-pane.mp-6-5.', 2);
  });

  it('C36 visual match: the conversation at its own address draws its messages in the mockup panel look at 1480, 900 and 390, light and dark', () => {
    holds(conversation, 'conversation.', 2);
  });

  it("MP-7-11 visual match: a conversation's messages match dock state p-ai's at 1480, 900 and 390, light and dark", () => {
    holds(conversation, 'conversation.agent-message', 1);
    holds(conversation, 'conversation.person-message', 1);
  });
});

// T-1's read with its newest attempt held and its effect unknown (C54), the
// state a person answers with one of the three outcomes or a write-off.
const T1 = madeUpAnswer(`${PREFIX.person}alpha${pathOf('task.read')}`)?.json as InternalTaskRead;
function unknownT1(): InternalTaskRead {
  const [lineage, ...rest] = T1.task.proposals;
  if (lineage === undefined) throw new Error('the made-up T-1 has no run');
  const held = {
    ...lineage.reservations[0],
    id: 'r-2',
    runId: 'run-2',
    state: 'held',
    actualMinor: null,
    releasedMinor: null,
    attempt: {
      id: 'at-2',
      state: 'liability_unknown',
      dispatchMarker: true,
      observed: false,
      dropCause: null,
    },
  } as (typeof lineage.reservations)[number];
  const reservations = [...lineage.reservations, held];
  return { ...T1, task: { ...T1.task, proposals: [{ ...lineage, reservations }, ...rest] } };
}

interface Capture {
  readonly name: string;
  readonly drawn: Readonly<Record<string, boolean>>;
  readonly overflow: number;
  readonly png: Buffer;
}

interface Harness {
  readonly browser: Browser;
  readonly app: URL;
  readonly session: string;
  readonly packet: ReturnType<typeof readPacket>;
}

/** One capture of the task page's agent section, with which of `marks` it drew. */
async function captureOne(
  at: Harness & { readonly width: number; readonly theme: Theme; readonly name: string },
  marks: Readonly<Record<string, string>>,
  prepare?: (context: BrowserContext) => Promise<unknown>,
): Promise<Capture> {
  const { packet, width, theme, name } = at;
  const side = await openSide(at.browser, packet, width, {
    app: at.app,
    session: at.session,
    colorScheme: theme,
  });
  try {
    await answerMadeUp(side.context);
    await prepare?.(side.context);
    const address = addressOf('agency:task-detail', PAGE_PARAMS) ?? '/';
    const page = await load(side, packet, new URL(address, at.app).href);
    await page.locator('[data-agent="pane"]').waitFor();
    const drawn: Record<string, boolean> = {};
    for (const [mark, selector] of Object.entries(marks))
      drawn[mark] = (await page.locator(selector).count()) > 0;
    const metrics = await page.evaluate(scrollMetrics);
    const [shot] = await shoot(page, name, { agent: '[data-section="agent"]' }, []);
    const overflow = metrics.scrollWidth - metrics.clientWidth;
    return { name, drawn, overflow, png: shot?.png ?? Buffer.alloc(0) };
  } finally {
    await side.context.close();
  }
}

/** The task page at each width and theme. */
async function capture(
  harness: Harness,
  label: string,
  marks: Readonly<Record<string, string>>,
  prepare?: (context: BrowserContext) => Promise<unknown>,
): Promise<Capture[]> {
  const shots: Capture[] = [];
  for (const width of WIDTHS)
    for (const theme of THEMES) {
      const name = `${label}@${String(width)}-${theme}`;
      shots.push(await captureOne({ ...harness, width, theme, name }, marks, prepare));
    }
  return shots;
}

/** Every capture drew every mark, inside its width, and dark unlike light. */
function proved(shots: readonly Capture[], marks: Readonly<Record<string, string>>): void {
  expect(shots).toHaveLength(WIDTHS.length * THEMES.length);
  for (const shot of shots) {
    for (const mark of Object.keys(marks))
      expect(shot.drawn[mark], `${shot.name} ${mark}`).toBe(true);
    expect(shot.overflow, `${shot.name} scrolls sideways`).toBe(0);
    expect(shot.png.subarray(1, 4).toString('latin1'), shot.name).toBe('PNG');
  }
  for (const width of WIDTHS) {
    const pick = (theme: Theme): Buffer =>
      shots.find((shot) => shot.name.endsWith(`@${String(width)}-${theme}`))?.png ??
      Buffer.alloc(0);
    const same = comparePng(`agent@${String(width)}`, pick('light'), pick('dark'));
    expect(same.pass, `agent@${String(width)} dark draws the same as light`).toBe(false);
  }
}

describe('SL12 harness captures (MP-1-7)', () => {
  let harness: Harness;
  let close: () => Promise<void>;
  const scratch = mkdtempSync(join(tmpdir(), 'sl12-captures-'));
  beforeAll(async () => {
    const packet = readPacket();
    await fetchAssets(readAssets(), packet);
    const browser = await launchChromium(MODE);
    const served = await serveApp();
    close = async () => {
      await browser.close();
      await served.close();
    };
    harness = { browser, app: served.app, session: madeUpSession(served.app, scratch), packet };
  }, 120_000);
  afterAll(async () => {
    await close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('MP-6-2 harness captures: the agent page of a run, hero stats, knowledge, artefacts and the side column, at 1480, 900 and 390, light and dark', async () => {
    const marks = {
      hero: '[data-hero="time"]',
      knowledge: '[data-agent="knowledge"] [data-knowledge="revision"]',
      supersedes: '[data-agent="evidence"] [data-evidence="version"]',
      side: '[data-agent="side"] [data-agent="given"]',
      tokens: '[data-agent="side"] [data-tokens="over"]',
    };
    proved(await capture(harness, 'mp-6-2', marks), marks);
  }, 300_000);

  it("C54 harness captures: an unknown effect's three outcomes, the write-off and the stop's answer, at 1480, 900 and 390, light and dark", async () => {
    const marks = {
      outcomes: '[data-agent="unknown-outcome"] [data-outcome]',
      writeOff: '[data-agent="write-off"] [data-write-off="submit"]',
      stop: '[data-agent="budget-stop"] [data-stop="top-up"]',
    };
    const unknown = unknownT1();
    const shots = await capture(harness, 'c54', marks, (context) =>
      context.route('**/api/b/*/task/read', (route) =>
        route.fulfill({ status: 200, json: unknown }),
      ),
    );
    proved(shots, marks);
  }, 300_000);
});
