ALTER TABLE textures ADD COLUMN source_resource_id INTEGER REFERENCES textures(id) ON DELETE SET NULL;
CREATE INDEX textures_source_resource ON textures(source_resource_id);
