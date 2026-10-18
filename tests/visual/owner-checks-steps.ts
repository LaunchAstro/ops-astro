// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// What every owner-check step is built from (owner-checks.ts): the widths, the
// beat a film holds each step for, and how a step says it missed.

import type { Page } from 'playwright';
import type { Theme } from './packet.ts';

export const PHONE = 390;
export const TABLET = 820;
export const LAPTOP = 1280;
/** How long each step stays on screen, so a person watching can follow it. */
export const BEAT = 900;

/**
 * How a step misses: `red` when its screen is wrong, `not here` when it needs a
 * real back end. Anything else a step throws is red too, with its message.
 */
export class Missed extends Error {
  readonly kind: 'red' | 'not here';
  constructor(kind: 'red' | 'not here', why: string) {
    super(why);
    this.kind = kind;
  }
}
export const red = (why: string): Missed => new Missed('red', why);

export type Act = (page: Page, at: Ctx) => Promise<void>;
export interface Ctx {
  readonly app: URL;
  readonly stamp: string;
}
export interface Check {
  readonly unit: string;
  /** The roadmap issue the unit's owner check lives on. */
  readonly issue: number;
  readonly title: string;
  readonly width: number;
  readonly theme?: Theme;
  readonly start: string;
  readonly steps: readonly (readonly [string, Act])[];
}

export const expectVisible = async (
  what: string,
  locate: () => ReturnType<Page['locator']>,
): Promise<void> => {
  const visible = await locate()
    .first()
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) throw red(`${what} not shown`);
};
export const notHere =
  (why: string): Act =>
  () =>
    Promise.reject(new Missed('not here', why));
export const go = async (page: Page, at: Ctx, path: string): Promise<void> => {
  await page.goto(new URL(path, at.app).href);
  await page.waitForFunction(() => document.querySelector('#app:empty') === null);
};
export const reload = async (page: Page): Promise<void> => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#app:empty') === null);
};

/** A caption drawn over the page, so the film says which step is on screen. */
export async function caption(page: Page, text: string): Promise<void> {
  await page
    .evaluate((line) => {
      let box = document.querySelector<HTMLElement>('#owner-check-caption');
      if (box === null) {
        box = document.createElement('div');
        box.id = 'owner-check-caption';
        box.style.cssText =
          'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:6px 10px;' +
          'background:rgba(15,20,30,.85);color:#fff;font:600 14px/1.3 system-ui;border-radius:6px;pointer-events:none';
        document.body.append(box);
      }
      box.textContent = line;
    }, text)
    .catch(() => {});
}
