CREATE INDEX IF NOT EXISTS auth_attempts_identifier_kind_created_idx ON auth_attempts(identifier, kind, created_at DESC);
