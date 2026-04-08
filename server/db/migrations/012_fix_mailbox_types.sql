-- Make all mailboxes shared by default
UPDATE mailboxes SET mailbox_type = 'shared' WHERE mailbox_type = 'personal';
