// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- finish each browser action before resetting its surface. */
import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
interface Control {
  readonly index: number;
  readonly tag: string;
  readonly occurrence: number;
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
        occurrence: elements
          .slice(0, index)
          .filter(
            (earlier) =>
              earlier.tagName === element.tagName &&
              earlier.checkVisibility({ checkVisibilityCSS: true }) &&
              (earlier.getAttribute('aria-label') ?? earlier.textContent?.trim()) ===
                (element.getAttribute('aria-label') ?? element.textContent?.trim()),
          ).length,
        name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
        visible: element.checkVisibility({ checkVisibilityCSS: true }),
        disabled: element.matches(':disabled,[aria-disabled=true]'),
        href: element.getAttribute('href'),
      }))
      .filter((control) => control.visible),
  );
}
async function clickControl(page: Page, selectors: string, control: Control): Promise<string> {
  await page.locator('[data-visual-click]').evaluateAll((elements) => {
    for (const element of elements) delete (element as HTMLElement).dataset['visualClick'];
  });
  const found = await page.locator(selectors).evaluateAll((elements, wanted) => {
    const element = elements
      .filter(
        (candidate) =>
          candidate.tagName === wanted.tag &&
          candidate.checkVisibility({ checkVisibilityCSS: true }) &&
          (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === wanted.name,
      )
      .at(wanted.occurrence);
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
    'xpath=ancestor::*[@data-comment-id or @data-step or @data-time-entry or @data-taskrow or self::tr or contains(@class,"sbtask") or contains(@class,"tl__row") or contains(@class,"msg ")][1]',
  );
  if ((await row.count()) > 0) await row.hover({ timeout: 4000 });
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
  const actions: Awaited<ReturnType<typeof captureAction>>[] = [];
  for (const [surface, prepare] of props.surfaces) {
    await prepare();
    await props.page.waitForTimeout(250);
    const root = ['board', 'page-agent'].includes(surface) ? '.content' : '.dpanel';
    const selectors = surface.includes('-menu-')
      ? `${root} [role=option]`
      : `${root} button,${root} a,${root} summary,${root} input[type=checkbox]`;
    await props.capture(`${surface}-inventory`);
    for (const control of await inventory(props.page, selectors)) {
      actions.push(await captureAction(props, surface, prepare, selectors, control));
      writeFileSync(`${props.out}/actions.json`, JSON.stringify(actions, null, 2));
    }
  }
  const failed = actions.filter((action) => !['clicked', 'disabled'].includes(action.outcome));
  if (failed.length > 0)
    throw new Error(
      `Control sweep failed: ${failed.map((action) => `${action.surface}: ${action.name} (${action.outcome})`).join('; ')}`,
    );
}
