import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: "/infinitycore-sara/", // ✅ MUST be here (top level)

  server: {
    port: 5173,
    open: true,
  }
})