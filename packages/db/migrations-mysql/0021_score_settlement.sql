-- MySQL 8.4 版迁移（自 packages/db/migrations/0021_score_settlement.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE textures ADD COLUMN score_refund_basis BIGINT NOT NULL DEFAULT 0;
ALTER TABLE textures ADD COLUMN score_award BIGINT NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN score_paid BIGINT NOT NULL DEFAULT 0;
