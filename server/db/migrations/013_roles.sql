-- Migration 013: Update role values to new permission system
-- Roles: rep, supervisor, manager

-- Convert old role values to new system
UPDATE users SET role = 'manager' WHERE role IN ('admin', 'Admin');
UPDATE users SET role = 'rep' WHERE role IN ('agent', 'Agent');

-- Ensure the first user (or craig@modco.com) gets manager role
UPDATE users SET role = 'manager' WHERE email = 'craig@modco.com';
UPDATE users SET role = 'manager' WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1) AND role IS NULL;
