import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Only run the source test suite. Without an explicit include, `vitest run`
    // also scans a stale local `dist/` build (which contains a bundled copy of
    // srs.test.js) and crashes the whole run, masking the real tests.
    include: ['src/**/*.test.{js,jsx}'],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
