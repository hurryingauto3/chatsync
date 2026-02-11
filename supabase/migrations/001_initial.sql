-- ChatSync: Initial schema
-- Run this in your Supabase project's SQL Editor

-- Core tables
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled',
  source_ide TEXT NOT NULL,  -- 'copilot' | 'cursor' | 'antigravity' | 'claude-code'
  source_hash TEXT UNIQUE,   -- Hash of original chat to detect duplicates
  workspace_path TEXT,       -- Project path for context
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,         -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  source_model TEXT,          -- 'gpt-4o' | 'claude-opus-4-6' | 'gemini-2.5-pro' etc
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Indexes
CREATE INDEX idx_conv_user ON conversations(user_id);
CREATE INDEX idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conv_hash ON conversations(source_hash);
CREATE INDEX idx_msg_conv ON messages(conversation_id);
CREATE INDEX idx_msg_ts ON messages(timestamp);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE conversations, messages;

-- RLS (users can only see/modify their own data)
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_conversations" ON conversations
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "own_messages" ON messages
  FOR ALL TO authenticated
  USING (conversation_id IN (SELECT id FROM conversations WHERE user_id = auth.uid()))
  WITH CHECK (conversation_id IN (SELECT id FROM conversations WHERE user_id = auth.uid()));
