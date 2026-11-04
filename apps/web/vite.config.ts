import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Live2D Studio',
        short_name: 'L2 Studio',
        description: 'Web-based 2D rigging & animation editor',
        theme_color: '#1b1d22',
        background_color: '#1b1d22',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
        file_handlers: [
          { action: '/', accept: { 'image/vnd.adobe.photoshop': ['.psd'], 'application/vnd.l2studio+zip': ['.l2studio'] } },
        ],
      } as Record<string, unknown>,
      workbox: { globPatterns: ['**/*.{js,css,html,svg,wasm}'], maximumFileSizeToCacheInBytes: 8 * 1024 * 1024 },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
});
