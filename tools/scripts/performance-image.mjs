import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from './paths.mjs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { makePng } = await import(pathToFileURL(resolve(repoRoot, 'packages/minecraft/test/png-builder.ts')));
const highEntropy = process.argv.includes('--high-entropy');
const bundle = process.argv.find(arg => arg.startsWith('--bundle='))?.slice('--bundle='.length) ?? 'reports/cloudflare/final-v2-one/worker.mjs';
const script = await readFile(resolve(repoRoot, bundle), 'utf8');
const mf = new Miniflare({
  name: 'image-performance', modules: [{ type: 'ESModule', path: 'worker.mjs', contents: script }],
  compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
  inspectorPort: 0, log: new Log(LogLevel.ERROR),
  d1Databases: { DB: 'image-performance' },
  durableObjects: { WORKLOADS: { className: 'Workloads', useSQLite: true } },
  serviceBindings: { TRACE: async () => new Response(null, { status: 204 }) },
});
let socket;
let timer;
try {
  await mf.ready;
  const inspector = await mf.getInspectorURL();
  const origin = new URL(inspector); origin.protocol = 'http:';
  const targets = await (await fetch(new URL('/json/list', origin))).json();
  const target = targets.find(item => item.title?.includes('image-performance') || item.id?.includes('image-performance'));
  const samples = [];
  let id = 0;
  if (target) {
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)); if (value.result?.usedSize !== undefined) samples.push(value.result); });
    timer = setInterval(() => socket.send(JSON.stringify({ id: ++id, method: 'Runtime.getHeapUsage' })), 20);
  }
  const namespace = await mf.getDurableObjectNamespace('WORKLOADS');
  const object = namespace.get(namespace.idFromName('image-compute'));
  const cases = [];
  for (const dimensions of highEntropy ? [[4096, 4096]] : [[4096, 4096], [4096, 2048]]) {
    const [width, height] = dimensions;
    const bytes = makePng({ width, height, seed: 31, highEntropy });
    const started = performance.now();
    const response = await object.fetch('https://workload/sanitize?area=16777216', { method: 'POST', body: bytes });
    const output = await response.arrayBuffer();
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('x-image-width')), width);
    assert.equal(Number(response.headers.get('x-image-height')), height);
    cases.push({ width, height, pixels: width * height, inputBytes: bytes.byteLength, outputBytes: output.byteLength, elapsedMs: performance.now() - started });
  }
  clearInterval(timer);
  const result = { cases, inspectorSamples: samples.length, peakHeapBytes: samples.length ? Math.max(...samples.map(item => item.usedSize)) : null, peakBackingBytes: samples.length ? Math.max(...samples.map(item => item.backingStorageSize ?? 0)) : null, memoryMeasurement: samples.length ? 'V8 inspector samples; not Cloudflare billing' : 'unavailable', cloudflareCpuMs: null };
  console.log(JSON.stringify(result));
  const output = resolve(repoRoot, 'reports/cloudflare');
  await mkdir(output, { recursive: true });
  const name = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? (highEntropy ? 'maximum-image-high-entropy.json' : 'maximum-image.json');
  await writeFile(resolve(output, name), JSON.stringify(result, null, 2));
} finally { clearInterval(timer); socket?.close(); await mf.dispose(); }
