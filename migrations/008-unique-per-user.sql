-- WP-187 Ф-J.1a + Ф-J.1d
-- Backfill source_type, add CHECK, replace UNIQUE(filename, source) with per-user UNIQUE.
--
-- Context: after Ф-J.1.code deploy, `ON CONFLICT (filename, source) DO NOTHING`
-- prevents cross-user hijack but blocks legitimate forkers from indexing
-- their copies of same-named repos (e.g. tserenovmailru/DS-my-strategy
-- collides with TserenTserenov/DS-my-strategy). The new UNIQUE key is
-- (filename, source, COALESCE(user_id, NIL_UUID)) — allows two owners
-- of the same source name, each with their own row.
--
-- NIL_UUID '00000000-0000-0000-0000-000000000000' is a sentinel for L2
-- (user_id IS NULL). It must match exactly in ON CONFLICT expression.

-- Step 1: backfill empty source_type by source-prefix rules
-- (mirrors resolveSourceType() in knowledge-mcp/src/index.ts)
UPDATE knowledge.documents
SET source_type = CASE
    WHEN source LIKE 'PACK-%' THEN 'pack'
    WHEN source LIKE 'DS-%' THEN 'ds'
    WHEN source IN ('SPF', 'FPF', 'ZP') THEN 'pack'
    WHEN source LIKE 'docs-%' OR source LIKE '%-docs' THEN 'guides'
    WHEN source LIKE 'FMT-%' THEN 'ds'
    ELSE 'ds'
END
WHERE source_type IS NULL OR source_type = '';

-- Step 2: enforce NOT NULL + valid values (no platform value — see Вариант α)
ALTER TABLE knowledge.documents ALTER COLUMN source_type SET NOT NULL;
ALTER TABLE knowledge.documents ADD CONSTRAINT source_type_valid
  CHECK (source_type IN ('pack', 'guides', 'ds', 'content')) NOT VALID;
ALTER TABLE knowledge.documents VALIDATE CONSTRAINT source_type_valid;

-- Step 3: new UNIQUE index per-user (expression index, must be called OUTSIDE this transaction).
-- See 008-unique-per-user-concurrent.sql for CONCURRENTLY step — Neon SQL editor.
-- After that, drop the old index. This file assumes sequential execution.
