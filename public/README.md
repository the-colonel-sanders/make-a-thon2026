# Food Saver dashboard

React + Vite frontend for the FastAPI backend in `../api`.

```bash
cd public
npm install
npm run dev        # http://localhost:5173 (also reachable from the LAN)
```

The API must be running (`uvicorn main:app --host 0.0.0.0 --port 8000` in `api/`).
Requests to `/api/*` are proxied to it, because the backend doesn't send CORS headers.
To point at another machine, create `public/.env` with `API_TARGET=http://<ip>:8000`.

For a production build: `npm run build` and then `npm run preview` (serves `dist/` with the same proxy).

Thresholds such as the danger zone and the 2-hour red limit are set in `src/config.js`.
