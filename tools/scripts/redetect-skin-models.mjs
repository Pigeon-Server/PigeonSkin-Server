// 存量皮肤模型重检驱动 —— 循环调用
// POST /api/v1/pigeon/admin/textures/redetect-skin-model 直至游标耗尽。
//
// 服务端逐行做「R2 读字节 → 解码 → 按像素判定 → 变更行清缓存」，
// 本脚本只负责翻页、429 退避与汇总，不做任何本地计算。
//
// 用法（仓库根执行）：
//   node tools/scripts/redetect-skin-models.mjs --site-url https://站点 --api-key <key> [--limit 50]
// api-key 在管理界面「Pigeon API」签发，scope 需含 admin.textures.write。
// --site-url 缺省为本地 dev（http://127.0.0.1:8787）。

const flag = (name) => {
  const inline = process.argv.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] ?? null : null;
};

const siteUrl = (flag('site-url') ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const apiKey = flag('api-key');
const limit = Number(flag('limit') ?? 50);
if (!apiKey) throw new Error('需要 --api-key（scope 含 admin.textures.write 的 Pigeon API key）');
if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit 取值 1..200');

let lastId = 0;
const totals = { processed: 0, changed: 0, skipped: 0 };
for (;;) {
  const res = await fetch(`${siteUrl}/api/v1/pigeon/admin/textures/redetect-skin-model`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ lastId, limit }),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
    console.warn(`触发限速，${seconds}s 后重试当前批次（lastId=${lastId}）`);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    continue;
  }
  if (!res.ok) throw new Error(`批次失败 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const batch = await res.json();
  totals.processed += batch.processed;
  totals.changed += batch.changed;
  totals.skipped += batch.skipped;
  console.log(`已处理 ${totals.processed}，变更 ${totals.changed}，跳过 ${totals.skipped}（nextCursor=${batch.nextCursor}）`);
  if (batch.nextCursor === null) break;
  lastId = batch.nextCursor;
}
console.log(`完成：${JSON.stringify(totals)}`);
