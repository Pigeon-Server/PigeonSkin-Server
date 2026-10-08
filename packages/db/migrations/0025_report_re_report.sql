-- 防滥用治理：管理员可禁用单个用户的举报提交权限与评论发表权限。
-- 举报防滥用（pending 去重 + 频控 + 验证码）在应用层执行，这里只存权限开关。
ALTER TABLE users ADD COLUMN reporting_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN comments_disabled INTEGER NOT NULL DEFAULT 0;
