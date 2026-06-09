-- WholesaleLedger — WhatsApp session persistence table
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS wa_sessions (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: only service role can access (backend uses service role key)
ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;

-- No public access — service role bypasses RLS automatically
