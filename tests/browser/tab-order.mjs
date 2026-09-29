// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the keyboard is: what has focus, and how many Tab presses reach a
// control. Split out of `keyboard-and-widths.mjs`, which drives the journey
// with these.

/** What has focus, in the words a person would use to point at it. */
export async function focused(page) {
  return await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return 'the document (nothing focused)';
    const name =
      el.getAttribute('aria-label') ??
      el.id ??
      (el.textContent ?? '').trim().slice(0, 30) ??
      el.tagName;
    return `<${el.tagName.toLowerCase()}> ${name}`;
  });
}

/**
 * Tab until the focused element matches, pressing at most `limit` times.
 *
 * Returns how many presses it took, which is the number a person would count,
 * or undefined when the tab order never reaches it -- a finding, not a crash.
 */
export async function tabTo(page, selector, limit = 25, text) {
  for (let pressed = 1; pressed <= limit; pressed += 1) {
    // eslint-disable-next-line no-await-in-loop -- one key at a time is the point.
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const there = await page.evaluate(
      (want) =>
        (document.activeElement?.matches(want.css) ?? false) &&
        (want.text === undefined ||
          (document.activeElement?.textContent ?? '').trim() === want.text),
      { css: selector, text },
    );
    if (there) return pressed;
  }
  return undefined;
}
