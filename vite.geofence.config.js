// Real-browser verification of the three reported web defects.
//
// The component under test is the SHIPPED one. Only the service's network layer
// is aliased (vite.harness.config.js) so the real GPS/geolocation path runs:
// the harness grants a mocked browser position and the page must put the pin,
// the circle, the map viewport and the coordinate fields there.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// A fake GPS fix, deliberately far from every branch centre, so a pass proves
// the position actually came from navigator.geolocation and was not defaulted
// to the branch's stored coordinates.
export const MOCK_FIX = { lat: 6.613799, lng: 3.351522 }

export default defineConfig({
  root: join(here, 'e2e-harness'),
  build: { rollupOptions: { input: { index: join(here, 'e2e-harness/index.html'), geofence: join(here, 'e2e-harness/geofence.html') } } },
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: [
      {
        find: /^\.\.\/\.\.\/services\/employeeTrackingService$/,
        replacement: join(here, 'e2e-harness/trackingServiceStub.js'),
      },
      {
        find: /^\.\.\/services\/geofenceService$/,
        replacement: join(here, 'e2e-harness/geofenceServiceStub.js'),
      },
    ],
  },
  server: { port: 4175, strictPort: true },
  preview: { port: 4175, strictPort: true },
})
