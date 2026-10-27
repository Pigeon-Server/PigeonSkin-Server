-- 存量材质净化标记（见 sqlite 版说明）。
ALTER TABLE textures ADD COLUMN sanitized INTEGER NOT NULL DEFAULT 0;
CREATE INDEX textures_unsanitized_idx ON textures (id) WHERE sanitized = 0;
