-- 存量材质净化标记。
--
-- 新上传的材质在 uploadTexture 里已解码重编码（规范 §2.7：剥离一切与位图
-- 无关的数据）。迁移前的历史行没有经过这一步，字节里可能仍带 tEXt/iCCP/eXIf
-- 等元数据；这张表上的标记让后台批处理（DO）能按批找出待处理项。
--
-- 默认 0 = 未净化。新上传显式写 1；存量批次处理成功后置 1，失败保持 0 以便重试。
ALTER TABLE textures ADD COLUMN sanitized INTEGER NOT NULL DEFAULT 0;
CREATE INDEX textures_unsanitized_idx ON textures (id) WHERE sanitized = 0;
