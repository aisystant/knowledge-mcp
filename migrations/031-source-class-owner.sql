-- WP-596 Ф7 (зонтик WP-542): classification metadata for knowledge_chunk sources.
-- source_class/source_owner answer "whose knowledge is this" (methodology/personal/
-- team/public_user, owner name) for the upcoming regional split (DP.ARCH.011) — they
-- are NOT an access-control mechanism; collection_kind/account_id remain the only
-- fields search/fetch use to decide what a caller may read.
--
-- Nullable, no backfill here: existing rows get source_class/source_owner from the
-- separate backfill script (scripts/backfill-source-class-owner.ts), run once this
-- migration is applied. New rows get the columns from ingest.ts going forward.

ALTER TABLE public.knowledge_chunk
  ADD COLUMN IF NOT EXISTS source_class TEXT,
  ADD COLUMN IF NOT EXISTS source_owner TEXT;

COMMENT ON COLUMN public.knowledge_chunk.source_class IS
  'Classification of the source''s knowledge (methodology|personal|team|public_user). '
  'Metadata for the regional split only — not an access-control field.';
COMMENT ON COLUMN public.knowledge_chunk.source_owner IS
  'Owner of the source ("platform" for methodology, a pilot/team name otherwise). '
  'A plain string, not an account_id — never compare it to a user UUID for access control.';
