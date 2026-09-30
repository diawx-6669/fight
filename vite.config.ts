import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    // getUserMedia requires a secure context; localhost counts as one.
    // For LAN testing run `vite --host` and use an https tunnel.
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          mediapipe: ['@mediapipe/tasks-vision'],
        },
      },
    },
  },
  // Классический воркер, а не модульный.
  //
  // MediaPipe подгружает свой WASM-загрузчик через `importScripts`, которого в
  // модульном воркере нет: модель падает с «ModuleFactory not set» ещё до
  // первого кадра. Поэтому воркер собирается одним файлом в формате IIFE, а
  // MediaPipe импортируется в нём статически — динамический импорт заставил бы
  // Vite резать его на чанки, чего IIFE не допускает.
  worker: {
    format: 'iife',
  },

  optimizeDeps: {
    exclude: [],
  },
});
