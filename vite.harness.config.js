import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: join(here, 'e2e-harness'),
  plugins: [react()],
  resolve: {
    alias: [
      // The component imports the service by that exact specifier; only the
      // network layer is swapped. The component source itself is the real one.
      {
        find: /^\.\.\/\.\.\/services\/employeeTrackingService$/,
        replacement: join(here, 'e2e-harness/trackingServiceStub.js'),
      },
    ],
  },
  server: { port: 4174, strictPort: true },
  preview: { port: 4174, strictPort: true },
})
