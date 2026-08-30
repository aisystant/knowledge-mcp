-- Down migration for 020-chunk-ordinal.sql
-- Refuses if any chunked (v2) rows exist — safe only before the first backfill.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM knowledge.documents WHERE chunk_ordinal > 1) THEN
    RAISE EXCEPTION 'chunk_ordinal rollback refused: chunked rows exist — irreversible past first backfill';
  END IF;
END $$;

-- Real prod index name (verified 2026-08-29), not idx_documents_fn_src_uid —
-- see 020-chunk-ordinal-concurrent.sql note.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_documents_user_source_filename
  ON knowledge.documents (filename, source, COALESCE(user_id, ''));

DROP INDEX CONCURRENTLY IF EXISTS knowledge.idx_documents_fn_src_uid_ord;

ALTER TABLE knowledge.documents DROP COLUMN IF EXISTS chunk_ordinal;
ALTER TABLE knowledge.documents DROP COLUMN IF EXISTS protocol_version;
