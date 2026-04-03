-- Migration 003: Retrieval Feedback (WP-184 Ф3)
-- Helpfulness signal from agents — basis for RAG v3 quality loop.

CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  query_hash VARCHAR(64) NOT NULL,
  helpfulness BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_document ON retrieval_feedback(document_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON retrieval_feedback(created_at);
