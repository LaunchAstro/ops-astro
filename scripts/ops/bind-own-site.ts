// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator step that binds the business's own site, its shape only: the
// step itself follows in the next commit. Until then it refuses every run.

/** The business's own site as the step binds it. */
export interface OwnSite {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
  readonly host: string;
  readonly pages: readonly { readonly pageUrl: string; readonly path: string }[];
}

/** agencyastro.com, Agency Astro's own site. */
export const AGENCY_ASTRO_SITE: OwnSite = {
  repository: 'launchastro/agency-astro-astro',
  defaultBranch: 'main',
  project: 'prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm',
  host: 'agencyastro.com',
  pages: [{ pageUrl: 'https://agencyastro.com/about', path: 'src/pages/about.astro' }],
};

/** Not built yet: every run is turned away, saying nothing. */
export async function runBindOwnSite(
  _environment: Readonly<Record<string, string | undefined>>,
  _site: OwnSite = AGENCY_ASTRO_SITE,
): Promise<{ readonly status: 0 | 1; readonly lines: readonly string[] }> {
  return await Promise.resolve({ status: 1, lines: [] });
}
