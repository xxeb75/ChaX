import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Two entries: the visible chat, and the windowless node the Android foreground service runs when the app is closed.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { rollupOptions: { input: { main: 'index.html', headless: 'headless.html' } } },
});
