// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- finish each browser action before resetting its surface. */
import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
interface Control {
  readonly index: number;
  readonly tag: string;
  readonly name: string | undefined;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly href: string | null;
}
interface SweepProps {
  readonly page: Page;
  readonly out: string;
  readonly capture: (name: string) => Promise<void>;
  readonly surfaces: readonly (readonly [string, () => Promise<void>])[];
}
function inventory(page: Page, selectors: string): Promise<Control[]> {
  return page.locator(selectors).evaluateAll((elements) =>
    elements
      .map((element, index) => ({
        index,
        tag: element.tagName,
        name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
        visible: Boolean(
          element.getBoundingClientRect().width && element.getBoundingClientRect().height,
        ),
        disabled: element.matches(':disabled,[aria-disabled=true]'),
        href: element.getAttribute('href'),
      }))
      .filter((control) => control.visible),
  );
}
async function clickControl(page: Page, selectors: string, control: Control): Promise<string> {
  const found = await page.locator(selectors).evaluateAll((elements, wanted) => {
    const element = elements.find(
      (candidate) =>
        candidate.tagName === wanted.tag &&
        getComputedStyle(candidate).display !== 'none' &&
        getComputedStyle(candidate).visibility !== 'hidden' &&
        (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === wanted.name,
    );
    if (element === undefined) return 'missing';
    if (element.matches(':disabled,[aria-disabled=true]')) return 'disabled';
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    (element as HTMLElement).dataset['visualClick'] = '';
    return 'ready';
  }, control);
  if (found !== 'ready') return found;
  const target = page.locator('[data-visual-click]');
  const row = target.locator(
    'xpath=ancestor::*[@data-comment-id or @data-step or @data-time-entry][1]',
  );
  if ((await row.count()) > 0) await row.hover();
  await target.click({ timeout: 4000 });
  return 'clicked';
}
async function captureAction(
  props: SweepProps,
  surface: string,
  prepare: () => Promise<void>,
  selectors: string,
  control: Control,
) {
  const action = { surface, ...control, outcome: 'disabled', screenshot: '', failure: '' };
  if (control.disabled) return action;
  await prepare();
  await props.page.waitForTimeout(250);
  try {
    action.outcome = await clickControl(props.page, selectors, control);
    if (action.outcome === 'clicked') {
      const name = `control-${surface}-${control.index}`;
      await props.capture(name);
      action.screenshot = `${name}.png`;
    }
  } catch (error) {
    action.outcome = String(error).split('\n')[0] ?? 'failed';
    action.failure = String(error);
    await props.capture(`failure-${surface}-${control.index}`);
  }
  return action;
}
export async function sweepControls(props: SweepProps): Promise<void> {
  const actions: unknown[] = [];
  for (const [surface, prepare] of props.surfaces) {
    await prepare();
    await props.page.waitForTimeout(250);
    const root = ['team', 'agent', 'draft', 'notifs', 'ai', 'clients', 'todos'].includes(surface)
      ? '.dpanel'
      : '.content';
    const selectors = `${root} button,${root} a,${root} summary`;
    for (const control of await inventory(props.page, selectors)) {
      actions.push(await captureAction(props, surface, prepare, selectors, control));
      writeFileSync(`${props.out}/actions.json`, JSON.stringify(actions, null, 2));
    }
  }
}
