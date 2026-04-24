import { Hono } from 'hono';

/**
 * Cloudflare Workers Backend Adapter
 * Note: Heavy dependencies like Puppeteer/FAISS will NOT work here.
 * This should only be used for lightweight logic and DB access.
 */
const app = new Hono();

app.get('/api/status', (c) => {
  return c.json({
    status: 'online',
    provider: 'cloudflare-workers',
    timestamp: new Date().toISOString()
  });
});

// Proxy other requests or implement lite logic
app.all('/api/*', (c) => {
  return c.json({ error: 'Full backend features are not available on Cloudflare Workers due to runtime limitations.' }, 501);
});

export default app;
