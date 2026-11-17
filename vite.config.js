import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  // Only scan the real app; old-files/ is a local backup copy.
  optimizeDeps: { entries: ['index.html'] },
  server: { watch: { ignored: ['**/old-files/**'] } },
})
