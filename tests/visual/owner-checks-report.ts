// SPDX-License-Identifier: AGPL-3.0-only
//
// The page the owner-check recordings are watched from (ops-astro#1747): one
// card per stage 1 unit, its film and each step's outcome, readable on a
// phone. Pure, so its escaping and its counts are tested without a browser;
// `owner-checks.ts` films the units and hands their results here.

/** What one step came to: it did what the owner check says, it did not, or it cannot be shown here. */
export type Outcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'red'; readonly why: string }
  | { readonly kind: 'not here'; readonly why: string };

export interface StepResult {
  readonly step: string;
  readonly outcome: Outcome;
}

export interface UnitResult {
  readonly unit: string;
  /** The roadmap issue the unit's own owner check lives on. */
  readonly issue: number;
  readonly title: string;
  /** The film's file name beside the page, or undefined when nothing could be filmed. */
  readonly video: string | undefined;
  readonly steps: readonly StepResult[];
}

export interface Pack {
  readonly stamp: string;
  readonly made: string;
  /** Where the films were made: the deployed made-up build, or a local copy. */
  readonly source: string;
  readonly units: readonly UnitResult[];
}

const ROADMAP = 'https://github.com/LaunchAstro/ops-astro-roadmap/issues/';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The unit's one-word verdict: red if any step was, otherwise partly when a step could not be shown. */
export function verdictOf(unit: UnitResult): 'ok' | 'red' | 'partly' {
  if (unit.steps.some((s) => s.outcome.kind === 'red')) return 'red';
  if (unit.steps.some((s) => s.outcome.kind === 'not here')) return 'partly';
  return 'ok';
}

/** One plain line per step, as a unit's issue comment and the run's log print it. */
export function stepLine(result: StepResult): string {
  const { outcome } = result;
  return outcome.kind === 'ok'
    ? `ok: ${result.step}`
    : `${outcome.kind}: ${result.step} (${outcome.why})`;
}

export function renderPack(pack: Pack): string {
  const cards = pack.units.map((unit) => {
    const verdict = verdictOf(unit);
    const film =
      unit.video === undefined
        ? '<p class="none">Nothing to film on made-up data.</p>'
        : `<video controls playsinline preload="metadata" src="${escapeHtml(unit.video)}"></video>`;
    const steps = unit.steps
      .map((s) => `<li class="${s.outcome.kind.replace(' ', '-')}">${escapeHtml(stepLine(s))}</li>`)
      .join('');
    return `<section><h2>${escapeHtml(unit.unit)} <span class="${verdict}">${verdict}</span></h2>
<p><a href="${ROADMAP}${String(unit.issue)}">${escapeHtml(unit.title)}</a></p>
${film}<ul>${steps}</ul></section>`;
  });
  const red = pack.units.filter((u) => verdictOf(u) === 'red').length;
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owner checks, stage 1</title>
<style>
:root{color-scheme:light dark;--ink:#1d2433;--bg:#f7f7f4;--card:#fff;--line:#d9dbe0;--ok:#1f7a4d;--red:#b42318;--part:#8a5a00}
@media (prefers-color-scheme:dark){:root{--ink:#e7e9ee;--bg:#14171d;--card:#1d2129;--line:#343a46;--ok:#5cc28e;--red:#ff8a80;--part:#e3b45c}}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,sans-serif}
main{max-width:760px;margin:auto}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin:0}video{width:100%;border-radius:6px;margin-top:6px}
ul{padding-left:18px}li{margin:4px 0}.ok{color:var(--ok)}.red{color:var(--red)}.partly,.not-here{color:var(--part)}a{color:inherit}
</style></head><body><main>
<h1>Owner checks, stage 1 (Foundation)</h1>
<p>Build <b>${escapeHtml(pack.stamp)}</b>, filmed ${escapeHtml(pack.made)} on made-up data on ${escapeHtml(pack.source)}, never production. ${String(red)} of ${String(pack.units.length)} units red.</p>
${cards.join('\n')}
</main></body></html>
`;
}
