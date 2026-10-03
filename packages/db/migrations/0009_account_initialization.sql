ALTER TABLE users ADD COLUMN needs_initialization INTEGER NOT NULL DEFAULT 0;
UPDATE users SET needs_initialization = 1
WHERE password_hash = '' OR email = '' OR email LIKE '%@oauth.invalid' OR email LIKE '%@oauth.local';
