CREATE INDEX textures_created_id_idx ON textures(created_at,id);
CREATE INDEX textures_catalog_revision_idx ON textures(catalog_revision,official_key,id);
