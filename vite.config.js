import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => ({
  plugins: [react()],
  // GitHub Pages (built only inside GitHub Actions) needs the
  // /infinitycore-sara/ subpath. Every other build — Vercel
  // production, local dev/preview — serves from the domain root.
  base: process.env.GITHUB_ACTIONS ? '/infinitycore-sara/' : '/',

  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
  }
}))
