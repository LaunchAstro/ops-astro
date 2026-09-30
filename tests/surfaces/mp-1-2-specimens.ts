// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// MP-1-2's type and icon specimens, read inside the browser from the drawn
// gallery (run by page.evaluate, so it holds no outside reference): the
// family each role resolves to, whether that family's face is loaded, and
// every icon's source and drawn size. The mockup's rounded icons came from
// an icon font; none may remain, and no glyph may be an emoji.

export type Specimens = {
  families: { display: string; text: string; mono: string };
  loaded: string[];
  icons: number;
  unlicensed: string[];
  undrawn: string[];
  iconFonts: string[];
};

export function specimens(expected: { display: string; text: string; mono: string }): Specimens {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const first = (element: Element | null): string =>
    element === null
      ? 'missing'
      : (getComputedStyle(element).fontFamily.split(',')[0] ?? '').trim().replaceAll('"', '');
  const families = {
    display: first(document.querySelector('.gallery__title')),
    text: first(document.querySelector('.gallery__state .btn')),
    mono: first(document.querySelector('.gallery__name .stamp')),
  };
  const loaded = Object.values(expected).filter((family) =>
    [...document.fonts].some(
      (face) => face.status === 'loaded' && face.family.replaceAll('"', '') === family,
    ),
  );
  const svgs = [...document.querySelectorAll('.gallery svg.icon')];
  const unlicensed = svgs
    .filter((svg) => !svg.classList.contains('lucide'))
    .map((svg) => svg.outerHTML.slice(0, 80));
  // An icon inside a closed disclosure is not drawn by design; every shown one has a size.
  const undrawn = svgs
    .filter((svg) => svg.checkVisibility())
    .filter((svg) => {
      const box = svg.getBoundingClientRect();
      return box.width === 0 || box.height === 0;
    })
    .map((svg) => svg.getAttribute('class') ?? '');
  const iconFonts = [...document.querySelectorAll('.gallery *')]
    .filter((element) => {
      const family = getComputedStyle(element).fontFamily.toLowerCase();
      const text = element.childNodes.length === 1 ? (element.textContent ?? '') : '';
      return /uicons|flaticon|icon/u.test(family) || /\p{Extended_Pictographic}|[-]/u.test(text);
    })
    .map((element) => element.outerHTML.slice(0, 80));
  return { families, loaded, icons: svgs.length, unlicensed, undrawn, iconFonts };
}
