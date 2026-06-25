-- WP-439 Ф1 rollback: drop the name_en provenance columns.
-- Safe: only removes columns added by 017-concept-en-provenance.sql.
-- name_en / name_ru values themselves are untouched.

BEGIN;

ALTER TABLE concept_graph.concepts DROP COLUMN IF EXISTS name_en_source;
ALTER TABLE concept_graph.concepts DROP COLUMN IF EXISTS name_en_status;

COMMIT;
