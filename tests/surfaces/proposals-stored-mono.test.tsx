// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The stored values a proposal prints (its payload and its evidence body) are
// set in the mono style (DS-TOK-125 `--type-mono`, docs/design-system/TOKENS.md:
// "Code, larger mono figures"), by the shared rule that sets code in it, and
// never by a copy of that rule beside the view. The MP-1-4 page census found
// a bare `pre.card__body` in neither: the browser's own monospace at the body's
// size, a style the scale does not have. Here every element that draws stored
// text must be one the shared rule selects, read from the shared sheet itself.

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { expect, it } from 'vitest';
import { Proposals } from '../../apps/web/src/views/proposals.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { mount } from './mount.tsx';

const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const bare = (path: string): string =>
  readFileSync(`${root}${path}`, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//gu, '');

/** Each rule of a sheet: its selector and its declarations, flattened out of any at-rule. */
const rules = (css: string): readonly { selector: string; body: string }[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selector = '', body = '']) => ({
    selector: selector.trim(),
    body,
  }));

/** Nothing here is sent: a press would be a fault of the case, not an answer. */
const client = new OperationsClient({
  origin: '',
  businessKey: 'alpha',
  signedIn: true,
  fetch: (async () => await Promise.reject(new Error('no request expected'))) as typeof fetch,
  newOperationId: () => 'operation-1',
});

const MONO = /font:\s*var\(--type-mono\)/u;

const PAYLOAD = { step: 'draft the quote' };
const EVIDENCE = { summary: 'Send the renewal quote.', aFieldNobodyFormats: 'kept verbatim' };

const lineage = {
  lineageId: 'l-0001',
  state: 'live',
  versions: [
    {
      versionId: 'v-1',
      version: 1,
      purpose: 'client_renewal_quote',
      maximumMinor: 250_000,
      currency: 'AUD',
      payloadDigest: 'digest-1',
      payload: PAYLOAD,
      supersededAt: null,
      runId: null,
      startedAt: null,
      endedAt: null,
      tokenUnits: null,
      pins: [],
      reads: [],
      checks: [],
      evidence: { id: 'e-1', renderer: 'core-runtime/evidence@1', digest: 'ev-1', body: EVIDENCE },
      gate: null,
    },
  ],
  decisions: [],
  reservations: [],
  scopes: [],
} as unknown as ProposalView;

/** The shared rule that sets code in the mono style: its selector, read from the shared sheet. */
function sharedMonoSelector(): string {
  const shared = rules(bare('packages/ui/src/styles/1-tokens.css')).filter(({ body }) =>
    MONO.test(body),
  );
  expect(shared.map(({ selector }) => selector)).toEqual([':where(code, kbd, samp)']);
  expect(shared[0]?.body).toMatch(/letter-spacing:\s*var\(--type-mono-tracking\)/u);
  expect(shared[0]?.body).toMatch(/text-transform:\s*var\(--type-mono-case\)/u);
  return shared[0]?.selector ?? '';
}

/** No copy of the style beside the view: the slice sheet sets no type on these blocks. */
function noLocalCopy(): void {
  for (const rule of rules(bare('apps/web/src/styles/6-slice.css'))) {
    if (/data-(?:evidence|version)/u.test(rule.selector)) {
      expect(rule.body, rule.selector).not.toMatch(/font|letter-spacing|text-transform/u);
    }
  }
}

const drawsText = (element: Element): boolean =>
  [...element.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  );

/** The block and every element under it that draws text itself. */
const drawingIn = (host: Element): readonly Element[] =>
  [host, ...host.querySelectorAll('*')].filter((element) => drawsText(element));

const view = (
  <Proposals
    client={client}
    proposals={[lineage]}
    envelope={null}
    topUpNote={null}
    onTopUpNote={() => {}}
    recordId="33333333-3333-4333-8333-333333333333"
    revision={1}
    note={null}
    onDecided={() => {}}
    proposeRefusal={null}
    onProposeRefused={() => {}}
    proposeDraft={null}
    onProposeDraft={() => {}}
    onChanged={() => {}}
    capCurrency="AUD"
  />
);

it('MP-1-4 a proposal’s stored payload and evidence are set in --type-mono by the shared code rule, not a local copy', async () => {
  const selector = sharedMonoSelector();
  noLocalCopy();
  const page = await mount(view);
  try {
    const blocks = [
      ['[data-version="payload"]', PAYLOAD],
      ['[data-evidence="body"]', EVIDENCE],
    ] as const;
    for (const [block, value] of blocks) {
      const [host] = page.all(block);
      if (host === undefined) throw new Error(`${block} is not drawn`);
      const drawing = drawingIn(host);
      expect(drawing.length, block).toBeGreaterThan(0);
      for (const element of drawing) {
        const tag = element.tagName.toLowerCase();
        expect(element.matches(selector), `${block}: <${tag}>`).toBe(true);
      }
      // Still printed as stored.
      expect(host.textContent).toBe(JSON.stringify(value, null, 2));
    }
  } finally {
    await page.unmount();
  }
});
