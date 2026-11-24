import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          mediapipe: ['@mediapipe/tasks-vision'],
          supabase: ['@supabase/supabase-js'],
          motion: ['animejs', 'qrcode'],
        },
      },
    },
  },
});
