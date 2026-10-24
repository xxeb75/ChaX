import { defineConfig } from 'vite';

// Two entries: the visible chat, and the windowless node the Android foreground service runs when the app is closed.
export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', headless: 'headless.html' } } },
});
