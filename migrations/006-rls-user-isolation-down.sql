-- Down migration for 006-rls-user-isolation.sql
-- WP-212 B6.2 — rollback RLS user isolation
-- USE WITH CAUTION: removes all row-level security from knowledge-mcp tables

-- documents
DROP POLICY IF EXISTS documents_user_isolation ON documents;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents NO FORCE ROW LEVEL SECURITY;

-- user_sources
DROP POLICY IF EXISTS user_sources_isolation ON user_sources;
ALTER TABLE user_sources DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_sources NO FORCE ROW LEVEL SECURITY;

-- github_installations
DROP POLICY IF EXISTS github_installations_isolation ON github_installations;
ALTER TABLE github_installations DISABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations NO FORCE ROW LEVEL SECURITY;

-- concept_graph.learner_concept_mastery
DROP POLICY IF EXISTS learner_mastery_isolation ON concept_graph.learner_concept_mastery;
ALTER TABLE concept_graph.learner_concept_mastery DISABLE ROW LEVEL SECURITY;
ALTER TABLE concept_graph.learner_concept_mastery NO FORCE ROW LEVEL SECURITY;

-- helper function
DROP FUNCTION IF EXISTS current_user_id();
