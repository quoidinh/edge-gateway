import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Redis } from '@upstash/redis/cloudflare';

type Bindings = {
    UPSTASH_REDIS_REST_URL: string;
    UPSTASH_REDIS_REST_TOKEN: string;
}

const app = new Hono<{ Bindings: Bindings }>();


// 1. Enable CORS with full credentials support
app.use('*', cors({
    origin: (origin) => origin, // Dynamic origin for VS Code Webview
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie'],
    exposeHeaders: ['Set-Cookie'],
    maxAge: 600,
    credentials: true,
}));

// Configuration for remote providers
const PROVIDERS = [
    { id: 'render1', name: 'Render Edge', url: 'https://coderx-backend.onrender.com' },
    { id: 'render2', name: 'Render Edge', url: 'https://coderx-backend-render.onrender.com' },
    { id: 'fly1', name: 'Fly Edge', url: 'https://coderx-backend-render.fly.dev' },
    // { id: 'vercel1', name: 'Vercel Edge', url: 'https://coderx-backend-vercel.vercel.app' },
    { id: 'railway1', name: 'Railway Edge', url: 'https://coderx-backend-railway.up.railway.app' }
];

app.all('*', async (c) => {
    try {
        const url = new URL(c.req.url);
        const headers = new Headers(c.req.raw.headers);
        const cookieHeader = c.req.header('Cookie') || '';
        const stickyProviderId = cookieHeader.match(/edge-provider=([^;]+)/)?.[1];

        // 1. Discover Healthy Providers
        let healthyProviders = [];

        // Support both Cloudflare (c.env) and Vercel/Node (process.env)
        const runtimeEnv = {
            UPSTASH_REDIS_REST_URL: (c.env as Bindings)?.UPSTASH_REDIS_REST_URL || (process as any).env?.UPSTASH_REDIS_REST_URL,
            UPSTASH_REDIS_REST_TOKEN: (c.env as Bindings)?.UPSTASH_REDIS_REST_TOKEN || (process as any).env?.UPSTASH_REDIS_REST_TOKEN,
        };

        if (!runtimeEnv.UPSTASH_REDIS_REST_URL || !runtimeEnv.UPSTASH_REDIS_REST_TOKEN) {
            // Local Simulator Mode or Missing Config
            console.warn('[Gateway] Redis credentials missing, entering simulator mode or using default providers');
            healthyProviders = [...PROVIDERS]; // Default to all if no redis
        } else {
            try {
                const redis = new Redis({
                    url: runtimeEnv.UPSTASH_REDIS_REST_URL,
                    token: runtimeEnv.UPSTASH_REDIS_REST_TOKEN,
                });

                for (const p of PROVIDERS) {
                    const isExhausted = await redis.get(`exhausted:${p.id}`);
                    if (!isExhausted) healthyProviders.push(p);
                }
            } catch (redisError: any) {
                console.error('[Gateway] Redis connection error:', redisError.message);
                healthyProviders = [...PROVIDERS]; // Fallback to all providers if redis fails
            }
        }


        if (healthyProviders.length === 0) {
            return c.json({ error: 'All providers exhausted' }, 503);
        }

        // 2. Select Initial Target
        let targetProvider = stickyProviderId
            ? healthyProviders.find(p => p.id === stickyProviderId) || healthyProviders[0]
            : healthyProviders[Math.floor(Math.random() * healthyProviders.length)];

        // 3. Proxy Execution with Auto-Retry
        let lastError = null;
        const body = ['GET', 'HEAD'].includes(c.req.method) ? null : await c.req.arrayBuffer();

        for (let attempt = 0; attempt < 2; attempt++) {
            const targetUrl = `${targetProvider.url}${url.pathname}${url.search}`;

            try {
                console.log(`[Gateway] Attempt ${attempt + 1}: Proxying to ${targetProvider.name} (${targetUrl})`);

                const response = await fetch(targetUrl, {
                    method: c.req.method,
                    headers: headers,
                    body,
                    redirect: 'manual'
                });

                const mergedHeaders = new Headers(response.headers);

                // 4. Fix Decoding & Compression issues
                // These headers must be removed because the edge runtime handles the body stream
                mergedHeaders.delete('content-encoding');
                mergedHeaders.delete('content-length');
                mergedHeaders.delete('transfer-encoding');

                // Add Sticky Cookie & Provider Info
                const stickyCookie = `edge-provider=${targetProvider.id}; Path=/; HttpOnly; SameSite=Lax`;
                mergedHeaders.append('Set-Cookie', stickyCookie);
                mergedHeaders.set('X-Backend-Provider', targetProvider.id);

                // Ensure CORS matches the request
                mergedHeaders.set('Access-Control-Allow-Origin', headers.get('Origin') || '*');
                mergedHeaders.set('Access-Control-Allow-Credentials', 'true');

                return new Response(response.body, {
                    status: response.status,
                    headers: mergedHeaders
                });

            } catch (err: any) {
                lastError = err;
                console.error(`[Gateway] Attempt ${attempt + 1} failed for ${targetUrl}:`, err.message);

                // Try another provider for the second attempt
                if (healthyProviders.length > 1) {
                    const otherProviders = healthyProviders.filter(p => p.id !== targetProvider.id);
                    targetProvider = otherProviders[Math.floor(Math.random() * otherProviders.length)];
                }
            }
        }

        return c.json({ error: 'Gateway Timeout', details: 'Backends unreachable', last_error: lastError?.message }, 504);

    } catch (e: any) {
        console.error('[Gateway] Critical Error:', e.message);
        return c.json({ error: 'Gateway Error', message: e.message }, 500);
    }
});

export default app;
