// SPDX-License-Identifier: AGPL-3.0-only
//
// The theme, before first paint (MP-1-1). A classic script, first in
// index.html's head, runs while the parser reads it, ahead of every stylesheet
// and module, so the first frame already carries data-theme and a dark system
// never flashes white. It is a same-origin file, not inline, because the
// content policy (S0-6c, script-src 'self') runs no inline script; the build
// emits it beside index.html (vite.config.ts). A preference is handed to it as
// data-theme-preference on the root element (light, dark or system); anything
// else follows the system, and keeps following it. Setting the attribute later
// goes through this same step. With none handed over, the tab's copy of the
// person's stored appearance (MP-2-11, apps/web/src/appearance.ts) is replayed,
// so a reload opens in the chosen theme.

(function () {
  var root = document.documentElement;
  var system = window.matchMedia('(prefers-color-scheme: dark)');
  if (root.dataset.themePreference === undefined) {
    var kept = null;
    try {
      kept = window.sessionStorage.getItem('ops-astro.appearance');
    } catch {
      // Storage refused: the system decides.
    }
    if (kept === 'light' || kept === 'dark' || kept === 'system') {
      root.dataset.themePreference = kept;
    }
  }
  function apply() {
    var chosen = root.dataset.themePreference;
    var dark = chosen === 'dark' || (chosen !== 'light' && system.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
  }
  apply();
  system.addEventListener('change', apply);
  new MutationObserver(apply).observe(root, {
    attributes: true,
    attributeFilter: ['data-theme-preference'],
  });
})();
