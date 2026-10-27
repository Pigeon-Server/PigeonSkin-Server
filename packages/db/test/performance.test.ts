import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
let db: InstanceType<typeof DatabaseSync>;
const now = 1_790_000_000_000;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const directory = resolve(import.meta.dirname, '../migrations');
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(resolve(directory, file), 'utf8'));
});
afterEach(() => db.close());

function user(id = 1) {
  db.prepare('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, `local${id}@example.invalid`, 'hash', now, now);
}
function texture(id = 1, visibility = 'public') {
  db.prepare("INSERT INTO textures(id,hash,kind,model,name,uploader_id,size_bytes,width,height,visibility,created_at,updated_at) VALUES(?,?,'skin','default','Local',1,2048,64,64,?,?,?)").run(id, String(id).padStart(64, '0'), visibility, now, now);
}
function stats() { return Object.fromEntries(db.prepare('SELECT metric,value FROM site_stats').all().map(row => [row.metric, row.value])); }
function snapshot(locale = '') { return JSON.parse(String(db.prepare('SELECT value FROM settings_snapshots WHERE locale=?').get(locale)?.value ?? '{}')); }

describe('配置快照与增量统计', () => {
  it('直接写入、覆盖、重命名及删除设置同步快照，保留原始字符串', () => {
    db.prepare('INSERT INTO settings(key,locale,value,updated_at) VALUES(?,?,?,?)').run('a.b', '', 'false', now);
    expect(snapshot()).toEqual({ 'a.b': 'false' });
    db.prepare("UPDATE settings SET key='renamed',locale='en',value='0' WHERE key='a.b'").run();
    expect(snapshot()).toEqual({});
    expect(snapshot('en')).toEqual({ renamed: '0' });
    db.prepare("DELETE FROM settings WHERE key='renamed'").run();
    expect(snapshot('en')).toEqual({});
  });

  it('设置回滚同时回滚快照和发布版本', () => {
    const before = db.prepare("SELECT version FROM public_cache_versions WHERE scope='settings'").get();
    db.exec('BEGIN');
    db.prepare("INSERT INTO settings(key,locale,value,updated_at) VALUES('site_name','','temporary',0)").run();
    db.exec('ROLLBACK');
    expect(snapshot()).toEqual({});
    expect(db.prepare("SELECT version FROM public_cache_versions WHERE scope='settings'").get()).toEqual(before);
  });

  it('材质分类数量随可见性、模型、类型和所有者改变', () => {
    user(); user(2); texture(); texture(2, 'private');
    expect(stats()).toMatchObject({ users: 2, textures: 2, texture_bytes: 4096 });
    expect(db.prepare("SELECT value FROM texture_counts WHERE scope='p:public'").get()).toMatchObject({ value: 1 });
    db.prepare("UPDATE textures SET visibility='public',uploader_id=2,model='slim',official_key='local-official' WHERE id=2").run();
    expect(db.prepare("SELECT value FROM texture_counts WHERE scope='u:1:private'").get()).toMatchObject({ value: 0 });
    expect(db.prepare("SELECT value FROM texture_counts WHERE scope='u:2:public' AND model='slim' AND official=1").get()).toMatchObject({ value: 1 });
    db.prepare("UPDATE textures SET kind='cape',model=NULL,size_bytes=4096 WHERE id=2").run();
    expect(stats().texture_bytes).toBe(6144);
    expect(db.prepare("SELECT SUM(value) AS n FROM texture_counts WHERE scope='p:public'").get()).toMatchObject({ n: 2 });
    db.prepare('DELETE FROM textures').run();
    expect(stats()).toMatchObject({ textures: 0, texture_bytes: 0 });
    expect(db.prepare('SELECT SUM(value) AS n FROM texture_counts').get()).toMatchObject({ n: 0 });
  });

  it('新增、删除、日期更正及事务回滚维护每日数量', () => {
    user(); texture();
    db.exec('BEGIN'); texture(2); db.exec('ROLLBACK');
    expect(stats().textures).toBe(1);
    db.prepare('UPDATE textures SET created_at=? WHERE id=1').run(now + 86_400_000);
    expect(db.prepare("SELECT SUM(value) AS n FROM daily_stats WHERE metric='uploads'").get()).toMatchObject({ n: 1 });
    db.prepare('DELETE FROM textures WHERE id=1').run();
    expect(db.prepare("SELECT SUM(value) AS n FROM daily_stats WHERE metric='uploads'").get()).toMatchObject({ n: 0 });
  });

  it('举报状态变化保持待处理总量准确', () => {
    user(); texture();
    db.prepare("INSERT INTO reports(texture_id,reporter_id,reason,status,created_at) VALUES(1,1,'local','pending',?)").run(now);
    expect(stats().pending_reports).toBe(1);
    db.prepare("UPDATE reports SET status='rejected' WHERE id=1").run();
    expect(stats().pending_reports).toBe(0);
    db.prepare("UPDATE reports SET status='pending' WHERE id=1").run();
    db.prepare('DELETE FROM reports WHERE id=1').run();
    expect(stats().pending_reports).toBe(0);
  });

  it('过期选择与普通列表排序使用索引', () => {
    for (const sql of ["SELECT id FROM auth_attempts WHERE created_at<0 ORDER BY created_at,id LIMIT 200", "SELECT id FROM sessions WHERE absolute_expires_at<0 ORDER BY absolute_expires_at,id LIMIT 200", "SELECT id FROM textures WHERE visibility='public' AND kind='skin' ORDER BY created_at DESC,id DESC LIMIT 24"]) {
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => String(row.detail));
      expect(plan.some(line => /SEARCH.*INDEX/.test(line))).toBe(true);
      expect(plan.some(line => /TEMP B-TREE/.test(line))).toBe(false);
    }
  });
});
