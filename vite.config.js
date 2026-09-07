import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // GitHub Pages uses the /infinitycore-sara/ base; dev/preview uses root.
  base: mode === 'production' ? '/infinitycore-sara/' : '/',

  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
  }
}))
