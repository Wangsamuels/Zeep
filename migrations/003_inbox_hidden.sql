-- Messages a user deleted. Zeep hides them even when the provider can't delete them yet
-- (StableEmail deletes need a wallet sign-in). Removed with the inbox.
CREATE TABLE IF NOT EXISTS inbox_hidden (
  inbox_id    TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  PRIMARY KEY (inbox_id, message_id)
);
