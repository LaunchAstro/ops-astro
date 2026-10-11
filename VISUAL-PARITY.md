# Projects and Tasks visual parity

Nathan's ruling R20261012 (12 October 2026) makes the running Hub mockup the canonical source for the layout and typography of Projects, Tasks and the Notifications, Agent, Clients and Projects dock panels. Data and licensed icon shapes may differ. The existing snapped type scale must not override the reference's intentional sizes, weights, line heights and spacing. Settings remains a full page and is removed from the shipped dock registry.

The CSS uses the existing type-census exception mechanism for measured reference styles that the older snapped scale cannot express. Every exception cites R20261012. This leaves the census active for all other rules and preserves its declared-style limit.

Shared custom selects retain the native select's form semantics and change events while providing the reference menu, selected tick and arrow. The native select is hidden from assistive technology and the visible button takes its accessible name. Keyboard navigation, disabled options, Escape, Tab and outside clicks use the same select controller.

Internal comments use an inline @ suggestion menu. Selected recipients follow the displayed name in the text; erasing that name removes its recipient id. An unmatched @ query can still be sent with Enter. The composer remains mounted when conversation tabs change, preserving caret position. Task ownership and grant changes clear drafts and suggestions according to the existing custody model. Client comments retain their own audience and never enable internal mention suggestions.

The subtask removal control uses the existing task.trash operation at the child's read revision, reports the returned batch count and retains an Undo that restores the same batch across a reread. Lost answers replay the held operation id. Receipts remain in memory under the signed-in client, grant and parent. Human approval steps retain their gate action and do not gain a removal control. Time removal uses its existing operation. Both controls appear on hover or keyboard focus.

The execution map is rendered immediately below the agent run summary, from the admitted execution read. The old lower rendering is suppressed in the composed Agent view. Refusals, loading and permissions remain real states.

`node tests/visual/projects-task-states.ts --out <directory>` captures interaction states and inventories their control geometry using isolated synthetic reads. It intercepts every API write, so the visual sweep changes no application records. Screenshots distinguish those refused writes from successful production actions. Final delivery must include exact-head checks and independent review. The director and orchestrator own integration and merging.

Preview and verification resolve `@launchastro/ui` to this checkout's source. The Vitest alias prevents a shared dependency symlink from silently testing another checkout. Vite also permits the resolved dependency directory so bundled fonts load when node_modules is shared; the existing secret, .local and Git deny rules remain active.

The production board intentionally omits the reference SWOT catalogue (Phase 6), Sync (replaced by live rereads), and agency-wide Agency/Client switch (rule R17 limits it to client-scoped pages). These are functional scope differences confirmed by the orchestrator, not missing decorative controls.

The shared New task drawer replaces the former inline quick-add creator,
matching the reference toolbar. Creation, scoped prefill, retained drafts,
timing and replay remain available through that drawer. The unbound topbar
Start timer opens task selection before timing can start, with an accessible
label naming both steps; a running timer's same control stops it.

The person-list contract supplies only names and identifiers. Two people with
the same display name therefore have identical mention labels; their selected
occurrences still bind distinct identifiers. Useful profile disambiguation
requires additional admitted identity context, rather than invented metadata.

The shared icon tokens now follow the live reference: extra-small inline
icons are 13px and small controls are 16px. The small name aliases the existing
16px medium token for API compatibility, with one maintained numeric value;
large icons retain their existing size. The affected RailParts, Notifications,
control toggles, treatments, assistant history/tabs, ProjectName and task pins
were inspected alongside the gallery and dock control sweep. This is a shared
reference update under R20261012, rather than a second feature-local icon scale.
Measured spacing uses existing shared steps wherever the values coincide.
Conversation row styles live together in 5-task.css for both task presentations.
