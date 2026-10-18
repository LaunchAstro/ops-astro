<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The agency's About page, as built and as served

The real bytes behind #1687: the page the first live correction changes,
"walk alongside you" becoming "walk beside you" (owner decision C21-3).

## `about.astro`

- Source: `src/pages/about.astro` in `LaunchAstro/agency-astro-astro`, at
  commit `299f9686267445a99c4f4dfd110a6c838e9e34d3` (main after
  agency-astro-astro#20, which moved the opening paragraph into the page
  file for agency-astro-astro#19).
- Git blob `cf392c6a1758314c71a3ca2578b484352231499e`, unchanged:
  `git hash-object about.astro` gives the same blob.
- Fetched 18 Oct 2026 through the GitHub contents API.

## `about.live.html`

- Source: `GET https://agencyastro.com/about` (status 200, no redirect,
  `content-type: text/html; charset=utf-8`), captured 18 Oct 2026 at
  02:22:13 UTC, `etag: "60ab8d49976f90a5f92b74ddae7d3a81"`.
- As served, its SHA-256 was
  `ff945894b8919afaf86850042d672608724af275b5aa797656d46fed643d880f`.
- The only change: every personal name on the page is replaced by a
  same-length placeholder, `X` then `x` for a capitalised name and `x` for
  a lowercase one, each matched as a whole word in both cases. That covers
  the five staff in the team section (with the founder line, photo paths
  and booking links) and the three individual people in the client logo
  strip (their alt text and image paths). Organisations stay as served,
  except one whose name the repository's public-content policy excludes,
  masked the same way.
  The file keeps its length, every other byte and the page's structure.
  None of the names sits near the corrected sentence, so the place and its
  equal matches are those of the served page.

No personal data, credential or client record is in either file.
