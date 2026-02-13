ALTER TABLE conversations DROP CONSTRAINT conversations_user_id_fkey;
ALTER TABLE conversations ALTER COLUMN user_id TYPE TEXT;