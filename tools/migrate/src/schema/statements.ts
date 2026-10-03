// 新库的写入语句模板。
//
// 单独成文件：SQL 文本全部是静态字符串 + ? 占位符，不含任何文件路径处理，
// 也不做任何值拼接 —— 安全审查可以只审这一个文件。
//
// 列名与 packages/db/migrations/0000_init.sql 一一对应；改 schema 时
// 必须同步改这里（typecheck 查不出字符串里的列名错误，verify 命令会）。

export const INSERT_USER = `INSERT OR IGNORE INTO users
  (id,email,nickname,locale,score,avatar_texture_id,password_hash,role,
   registration_ip,is_dark_mode,last_sign_at,email_verified_at,created_at,updated_at,legacy_email_conflict)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export const INSERT_TEXTURE = `INSERT OR IGNORE INTO textures
  (id,hash,kind,model,name,uploader_id,size_bytes,visibility,width,height,likes,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export const INSERT_PLAYER = `INSERT OR IGNORE INTO players
  (id,user_id,name,skin_texture_id,cape_texture_id,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?)`;

export const INSERT_CLOSET = `INSERT OR IGNORE INTO closet (user_id,texture_id,item_name,created_at)
  VALUES (?,?,?,?)`;

export const INSERT_REPORT = `INSERT OR IGNORE INTO reports
  (id,texture_id,uploader_id,reporter_id,reason,status,resolution,created_at,reviewed_at)
  VALUES (?,?,?,?,?,?,?,?,?)`;

export const INSERT_NOTIFICATION = `INSERT INTO notifications
  (user_id,type,title,body,read_at,created_at) VALUES (?,?,?,?,?,?)`;

export const UPSERT_SETTING = `INSERT INTO settings (key,locale,value,updated_at)
  VALUES (?,?,?,?)
  ON CONFLICT (key,locale) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

// ── 旧库的读取语句（静态文本，同样只有 ? 占位符）────────────────────────────

export const COUNT_USERS = `SELECT COUNT(*) AS n FROM users`;
export const FETCH_USERS = `SELECT uid,email,nickname,locale,score,avatar,password,ip,
    is_dark_mode,permission,last_sign_at,register_at,verified
  FROM users ORDER BY uid LIMIT ? OFFSET ?`;

export const COUNT_TEXTURES = `SELECT COUNT(*) AS n FROM textures`;
export const FETCH_TEXTURES = `SELECT tid,name,type,hash,size,uploader,public,upload_at,likes
  FROM textures ORDER BY tid LIMIT ? OFFSET ?`;

export const DISTINCT_TEXTURE_HASHES = `SELECT DISTINCT hash FROM textures`;

export const COUNT_PLAYERS = `SELECT COUNT(*) AS n FROM players`;
export const FETCH_PLAYERS = `SELECT pid,uid,name,tid_skin,tid_cape,last_modified
  FROM players ORDER BY pid LIMIT ? OFFSET ?`;

export const FETCH_CLOSET = `SELECT user_uid,texture_tid,item_name FROM user_closet`;

export const FETCH_REPORTS = `SELECT id,tid,uploader,reporter,reason,status,report_at
  FROM reports ORDER BY id`;

export const FETCH_NOTIFICATIONS = `SELECT id,type,notifiable_id,data,read_at,created_at
  FROM notifications`;

export const FETCH_OPTIONS = `SELECT option_name,option_value FROM options`;

// ── 插件内置化新表的迁移源（0002 迁移建的表）────────────────────────────────

export const FETCH_UUIDS = `SELECT name, uuid FROM uuid`;
export const INSERT_UUID = `INSERT INTO uuid (player_id, name, uuid) SELECT id, name, ? FROM players WHERE name = ? COLLATE NOCASE ON CONFLICT(player_id) DO NOTHING`;

export const FETCH_DESCRIPTIONS = `SELECT tid, description FROM textures_description`;
export const INSERT_DESCRIPTION = `INSERT INTO textures_description (tid, description, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (tid) DO UPDATE SET description = excluded.description`;

/** 新库里已有的 id 集合（用于悬空引用过滤；由调用方绑定参数） */
export const NEW_TEXTURE_IDS = `SELECT id FROM textures`;
export const NEW_USER_IDS = `SELECT id FROM users`;

// ── verify 命令的对照查询 ────────────────────────────────────────────────────

export const VERIFY_USER_IDS = `SELECT id FROM users ORDER BY id`;
export const VERIFY_TEXTURE_IDS = `SELECT id,hash FROM textures ORDER BY id`;
export const VERIFY_PLAYER_IDS = `SELECT id,user_id,name FROM players ORDER BY id`;
export const VERIFY_CLOSET_COUNT = `SELECT COUNT(*) AS n FROM closet`;
export const VERIFY_REPORT_IDS = `SELECT id FROM reports ORDER BY id`;
export const VERIFY_SETTING_KEYS = `SELECT key,locale FROM settings`;
