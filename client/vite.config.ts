import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    https: process.env.VITE_HTTPS === 'true' ? {
      key: fs.readFileSync(path.resolve(__dirname, '../server/server.key')),
      cert: fs.readFileSync(path.resolve(__dirname, '../server/server.cert')),
    } : undefined,
    proxy: {
      '/api': {
        target: process.env.VITE_HTTPS === 'true' ? 'https://localhost:3001' : 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/v1': {
        target: process.env.VITE_HTTPS === 'true' ? 'https://localhost:3001' : 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
