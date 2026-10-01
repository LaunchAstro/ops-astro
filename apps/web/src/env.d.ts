// SPDX-License-Identifier: AGPL-3.0-only
//
// The one build-time value the web app reads (`apps/web/vite.config.ts`), by
// name, so the build replaces it alone (G3).

interface ImportMetaEnv {
  readonly VITE_OPS_ASTRO_BUILD?: string;
}
