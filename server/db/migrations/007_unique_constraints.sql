-- Add unique constraint to prevent duplicate conversations per thread per mailbox
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_thread_mailbox
  ON conversations(gmail_thread_id, mailbox_id)
  WHERE gmail_thread_id IS NOT NULL;

-- Add unique index on gmail_message_id per conversation to prevent duplicate messages
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_gmail_id_conv
  ON messages(gmail_message_id, conversation_id)
  WHERE gmail_message_id IS NOT NULL;
