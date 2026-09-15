# Postgres owns knowledge; exports are projections

Accepted 6 September 2026; document-body format reopened 7 September.

Knowledge lives in Postgres. Markdown folders are exports of that store and
do not create a second write authority. This prevents file synchronisation
from competing with permissions, version history, and approved edits.

The earlier decision to make every body canonical Markdown is reopened for
rich-document fidelity review. Postgres remains canonical storage. No
replacement body format or editor has been selected. Preserve useful existing
rich documents and Notes interactions until the proposed format can represent
them without loss.

Agent-facing document commands must read a named version and propose edits
against that version. Stale proposals fail; authorised approval controls
promotion to the current version. Search indexes, embeddings, exports, and
agent scratch files cannot silently replace the approved document or change
active skill permissions. The complete command and copy-control contract
remains to be specified in the later Docs phase.
