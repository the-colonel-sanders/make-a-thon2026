import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The FastAPI backend (api/main.py) has no CORS headers, so the browser can't
// call it directly from another origin. Instead, every request to /api/* is
// proxied server-side to the backend, which keeps the site same-origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.API_TARGET || 'http://localhost:8000'
  const proxy = {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  }
  return {
    plugins: [react()],
    // Vite's own "public/" static-assets folder would collide with this
    // project's directory name, so static assets live in ./static instead.
    publicDir: 'static',
    server: { host: true, port: 5173, proxy },
    preview: { host: true, port: 4173, proxy },
  }
})
