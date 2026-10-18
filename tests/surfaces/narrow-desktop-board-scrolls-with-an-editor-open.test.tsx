// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { mount } from './mount.tsx';

const row: ProjectRow = {
  id: 'narrow',
  key: 'OPS-1',
  name: 'Oil the hinge',
  client: null,
  rank: { number: null, calc: '' },
  starred: false,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 1,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
};

// Walk the actual board stylesheet at the criterion's desktop width. Include
// overflow's shorthand: it sets both axes and can override overflow-x.
function matchingOverflow(wrap: Element): string[] {
  const style = document.createElement('style');
  style.textContent = readFileSync('packages/ui/src/styles/4b-board-machine.css', 'utf8');
  document.head.append(style);
  const declarations: string[] = [];
  const visit = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        const constraints = [...rule.conditionText.matchAll(/\((min|max)-width:\s*(\d+)px\)/gu)];
        const matches = constraints.every(([, edge, px]) =>
          edge === 'min' ? 1480 >= Number(px) : 1480 <= Number(px),
        );
        if (rule.conditionText.startsWith('not all and ') ? !matches : matches)
          visit(rule.cssRules);
      } else if (rule instanceof CSSStyleRule && wrap.matches(rule.selectorText)) {
        const value =
          rule.style.getPropertyValue('overflow-x') ||
          rule.style.getPropertyValue('overflow').split(/\s+/u)[0];
        if (value) declarations.push(value);
      }
    }
  };
  try {
    visit(style.sheet!.cssRules);
  } finally {
    style.remove();
  }
  return declarations;
}

it('opening an inline editor keeps a narrow desktop board horizontally scrollable', async () => {
  const board = await mount(
    <ProjectsBoard
      rows={[row]}
      stages={[]}
      href={() => '/tasks/OPS-1'}
      width={400}
      viewport={1480}
      actions={{ onDue: () => {} }}
    />,
  );
  const wrap = board.find('.cbd__wrap')!;
  expect(Object.hasOwn((wrap as HTMLElement).dataset, 'overflows')).toBe(true);
  expect(
    Number((board.find('table') as HTMLElement).style.width.replace(/px$/u, '')),
  ).toBeGreaterThan(400);
  expect(board.find('th[data-key="actual"]')).not.toBeNull();
  expect(matchingOverflow(wrap).at(-1)).toBe('auto');
  await board.click('td[data-key="due"] .cbd__edb');
  expect(board.find('.cbd__cell.is-editing')).not.toBeNull();
  // This later selector is more specific than .cbd__wrap. Its shorthand
  // currently wins and removes the scrolling established above.
  expect(matchingOverflow(wrap).at(-1), 'the open editor must retain the scroll container').toBe(
    'auto',
  );
});
