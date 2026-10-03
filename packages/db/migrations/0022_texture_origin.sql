ALTER TABLE textures ADD COLUMN origin TEXT NOT NULL DEFAULT 'original' CHECK (origin IN ('original', 'repost'));
UPDATE textures SET origin = 'repost' WHERE official_key IS NOT NULL;
