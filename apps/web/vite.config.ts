import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
const target = process.env.API_TARGET ?? 'http://127.0.0.1:8787';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [vue(), tailwindcss(), {
    name: 'public-manual-content',
    generateBundle() {
      const directory = fileURLToPath(new URL('./src/content/manual', import.meta.url));
      const content = Object.fromEntries(readdirSync(directory).filter(file => file.endsWith('.md')).map(file => [file.slice(0, -3), readFileSync(`${directory}/${file}`, 'utf8')]));
      this.emitFile({ type: 'asset', fileName: 'manual-content.json', source: JSON.stringify(content) });
      for (const locale of ['en', 'zh_TW', 'es_ES', 'ru_RU', 'ja_JP']) {
        this.emitFile({ type: 'asset', fileName: `manual-content.${locale}.json`, source: readFileSync(`${directory}/localized/${locale}.json`, 'utf8') });
      }
    },
  }],
  server: { port: 5173, proxy: Object.fromEntries(['/api', '/textures', '/csl', '/skin/', '/cape/', '/usm/', '/raw', '/avatar', '/preview', '/auth/oauth', '/mojang', '/yggdrasil', '^/[^/]+\\.json$'].map((p) => [p, { target, changeOrigin: true }])) },
  build: {
    outDir: 'dist', sourcemap: true,
    rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
  },
});
