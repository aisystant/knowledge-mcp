-- Run against the knowledge database BEFORE deploying the caller.
-- FORCE RLS prevents the worker's non-leakproof keyword predicates from using
-- GIN indexes. This fixed public-only API keeps the worker's table/RLS privileges
-- unchanged. It accepts no account, identifiers, SQL, or caller expressions.
-- Rank and limit BEFORE materializing the function result (at most 20 excerpts).
-- The 2000-character excerpt and marker match the public search response contract;
-- keep them aligned with src/index.ts (the PostgreSQL regression checks both).
-- Requires an existing BYPASSRLS migration owner and knowledge_app_reader role.
-- CREATE (not REPLACE) fails closed on a conflicting function. All privileges
-- are installed atomically; unexpected default grants abort the transaction.
-- Rollback: deploy the previous caller first, then DROP FUNCTION
-- public.search_platform_keyword_candidates(text,text,text,text,text,text,integer);

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'keyword candidate function requires a BYPASSRLS owner';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'knowledge_app_reader') THEN
    RAISE EXCEPTION 'expected worker role does not exist';
  END IF;
END
$preflight$;

CREATE FUNCTION public.search_platform_keyword_candidates(
  p_pattern text,
  p_entity_pattern text,
  p_section_pattern text,
  p_fts_query text,
  p_source text,
  p_source_kind text,
  p_limit integer
)
RETURNS TABLE (
  id bigint,
  filename text,
  content text,
  source text,
  source_type text,
  score numeric,
  sort_path_priority integer,
  sort_content_length integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $candidates$
  SELECT c.legacy_id AS id, c.source_uri AS filename,
         CASE WHEN length(c.content) > 2000
              THEN left(c.content, 2000) || E'\n\n...[truncated; use get_document for the full document]'
              ELSE c.content END AS content,
         c.source, c.source_kind AS source_type,
         CASE
           WHEN c.source_uri ILIKE p_pattern THEN 1.0
           WHEN p_entity_pattern IS NOT NULL
                AND c.source_uri ILIKE p_entity_pattern
                AND p_section_pattern IS NOT NULL
                AND c.content ILIKE p_section_pattern THEN 0.98
           WHEN c.source_uri ILIKE p_entity_pattern AND p_entity_pattern IS NOT NULL THEN 0.95
           WHEN c.content ILIKE p_pattern THEN 0.90
           WHEN c.search_vector @@ plainto_tsquery('simple', p_fts_query) THEN 0.8
           ELSE 0.5
         END AS score,
         CASE WHEN c.source_uri ILIKE p_pattern THEN 0 ELSE 1 END AS sort_path_priority,
         length(c.content) AS sort_content_length
  FROM public.knowledge_chunk AS c
  WHERE c.account_id IS NULL
    AND (c.content ILIKE p_pattern
         OR c.source_uri ILIKE p_pattern
         OR c.search_vector @@ plainto_tsquery('simple', p_fts_query)
         OR (p_entity_pattern IS NOT NULL AND c.source_uri ILIKE p_entity_pattern))
    AND (p_source IS NULL OR c.source = p_source)
    AND (p_source_kind IS NULL OR c.source_kind = p_source_kind)
  ORDER BY score DESC, sort_path_priority, sort_content_length DESC
  LIMIT LEAST(20, GREATEST(1, COALESCE(p_limit, 5)))
$candidates$;

REVOKE ALL ON FUNCTION public.search_platform_keyword_candidates(text,text,text,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_platform_keyword_candidates(text,text,text,text,text,text,integer) TO knowledge_app_reader;

DO $verify$
DECLARE
  candidate regprocedure := 'public.search_platform_keyword_candidates(text,text,text,text,text,text,integer)'::regprocedure;
BEGIN
  IF EXISTS (
    SELECT FROM pg_proc p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = candidate
      AND (a.grantee NOT IN (p.proowner, 'knowledge_app_reader'::regrole)
           OR (a.grantee <> p.proowner AND a.is_grantable))
  ) THEN
    RAISE EXCEPTION 'unexpected keyword candidate function grants';
  END IF;
END
$verify$;
COMMIT;
