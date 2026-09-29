// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared interface package's one entry point, and the surface a code-side
// discovery check reads.
//
// It is `export *` per module rather than a hand-written list, so a component
// added to a module below appears here without anybody remembering to add it —
// which is the whole reason the capability map's missing-registration check can
// be trusted in the code-to-map direction.
//
// **The naming rule this package lives under, because the check depends on it:
// an export in PascalCase is a UI component and must carry a capability-map
// entry; everything else is camelCase or UPPER_CASE and must not.** It is a
// convention, and it is checkable from the built artefact, which is more than
// can be said for a comment asserting the same thing.
//
// This package imports no `core-*` package and must not. It owns visual
// controls and layout; session-scoped panel registration, open state and drafts
// belong to `apps/web` [ui-reference CONTRACT.md:305].
//
// **What the working slice carries and what it leaves in the draft.** The draft
// at `ops-astro-t1-draft@60f2009` also exports `AgentTab`, `AgentPanel` and
// `Gate`. All three draw surfaces the slice's three screens do not reach and
// whose records no part of this build stores, so they are not ported: an
// exported component that nothing mounts is an estate to maintain, not a
// capability. They stay in the draft until the phase that owns them lands.

// The package's stylesheets, in their load order: the font faces, then tokens,
// then primitives, then the shell, then the board, then the task surfaces. They enter through this
// file like everything else in the package, and `apps/web/src/main.tsx` imports
// the package before its own sheet, so the order holds in the bundle.
import './styles/0-fonts.css';
import './styles/1-tokens.css';
import './styles/2-primitives.css';
import './styles/3-shell.css';
import './styles/4-board.css';
import './styles/5-task.css';

export * from './state/corpus.ts';
export * from './state/project.ts';
export * from './kit/controls.tsx';
export * from './kit/gallery.tsx';
export * from './kit/marks.tsx';
export * from './primitives/Absence.tsx';
export * from './primitives/BrandMark.tsx';
export * from './primitives/Icon.tsx';
export * from './primitives/Status.tsx';
export * from './primitives/Tabs.tsx';
export * from './surfaces/Shell.tsx';
export * from './surfaces/Board.tsx';
export * from './surfaces/TaskPage.tsx';
