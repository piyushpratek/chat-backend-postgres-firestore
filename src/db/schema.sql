-- Relational side of the chat backend: who the users are, which chats exist,
-- and who is a member of each chat. Messages live in Firestore.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
  email       TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  name        TEXT,
  -- For 1:1 chats: "<smaller user id>:<larger user id>". The UNIQUE constraint
  -- guarantees there is only ever one 1:1 chat per pair, even under concurrent requests.
  direct_key  TEXT UNIQUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped whenever a message is sent, so "list my chats" shows the most recent first.
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_type_shape CHECK (
    (type = 'direct' AND direct_key IS NOT NULL)
    OR (type = 'group' AND direct_key IS NULL AND name IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

-- "List chats for a user" looks members up by user_id.
CREATE INDEX IF NOT EXISTS chat_members_user_id_idx ON chat_members (user_id);
CREATE INDEX IF NOT EXISTS chats_updated_at_idx ON chats (updated_at DESC);
