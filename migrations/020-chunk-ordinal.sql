-- WP-7 Ф94 — chunk_ordinal + protocol_version for knowledge.documents
--
-- Context: get_document/personal_get_document currently LIMIT 1 when reading a
-- document that was split into multiple chunk rows at index time (filename
-- encoded as "path::section"), silently returning one section instead of the
-- whole document. Fix moves ordering into a real column instead of encoding
-- it into the filename string (WP-7 Ф94 peer-session — string encoding proven
-- non-injective, see session 2026-08-29-05-chunk-truncation-fix turn 5).
--
-- protocol_version distinguishes legacy chunk-key rows (v1, implicit DEFAULT 1,
-- old code never sets it) from new chunk_ordinal rows (v2, explicit) — needed
-- because chunk_ordinal alone collides: a legacy single-chunk row and a new
-- single-chunk row are both indistinguishable at chunk_ordinal=1 (see same
-- session, turn "chunk_ordinal сам по себе не версия").
--
-- Both columns default to constants — Postgres 11+ ADD COLUMN with a constant
-- DEFAULT is metadata-only, no table rewrite (same assumption already relied
-- on by this table's own migration 008).

ALTER TABLE knowledge.documents ADD COLUMN IF NOT EXISTS chunk_ordinal INTEGER NOT NULL DEFAULT 1;
ALTER TABLE knowledge.documents ADD COLUMN IF NOT EXISTS protocol_version SMALLINT NOT NULL DEFAULT 1;

-- New unique index created in 020-chunk-ordinal-concurrent.sql (CONCURRENTLY,
-- run outside this transaction — same two-step pattern as 008/008-concurrent).
-- Do NOT drop the old index here; see the concurrent file for the safe order.
