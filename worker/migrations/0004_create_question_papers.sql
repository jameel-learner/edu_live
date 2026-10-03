CREATE TABLE question_papers (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  class TEXT NOT NULL,
  marks_total INTEGER NOT NULL,
  chapter_filenames TEXT NOT NULL,
  blueprint_version TEXT NOT NULL,
  paper_json TEXT NOT NULL,
  answer_key_json TEXT,
  pdf_r2_key TEXT,
  answer_key_pdf_r2_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_question_papers_cache_key ON question_papers (cache_key);
