ALTER TABLE textures ADD COLUMN sanitized TINYINT NOT NULL DEFAULT 0;
CREATE INDEX textures_unsanitized_idx ON textures (sanitized,id);
