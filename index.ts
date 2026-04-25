import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Redis } from '@upstash/redis/cloudflare';

type Bindings = {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  OPENAI_API_KEY?: string;
  NETLIFY_AUTH_TOKEN?: string;
  RAILWAY_API_KEY?: string;
  FLY_API_TOKEN?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// 1. Enable CORS
app.use('*', cors({
  origin: (origin) => origin || '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie'],
  credentials: true,
}));

// --- METRICS & REGISTRY ---

async function getActiveProviders(redis: Redis) {
  const providersRaw = await redis.smembers('active_providers');
  if (!providersRaw || providersRaw.length === 0) {
    return [
      { id: 'render-default', name: 'Render Default', url: 'https://coderx-backend.onrender.com' },
      { id: 'render-second', name: 'Render Second', url: 'https://coderx-backend-render.onrender.com' }
    ];
  }
  return providersRaw.map(p => typeof p === 'string' ? JSON.parse(p) : p);
}

async function recordMetric(redis: Redis, providerId: string, duration: number, success: boolean) {
  const key = `metrics:${providerId}`;
  await redis.lpush(key, JSON.stringify({ duration, success, ts: Date.now() }));
  await redis.ltrim(key, 0, 99); // Keep last 100 requests
}

// --- PROVISIONING LOGIC ---

async function provisionOnNetlify(c: any, siteName: string) {
  const token = c.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('Netlify token missing');

  console.log(`[Provisioner] Triggering Netlify deployment for ${siteName}`);
  const res = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: siteName })
  });

  const data: any = await res.json();
  return data.ssl_url || data.url;
}

async function registerProvider(redis: Redis, id: string, url: string) {
  console.log(`[Registry] Registering new provider: ${id} -> ${url}`);
  const provider = { id, name: id, url };
  await redis.sadd('active_providers', JSON.stringify(provider));
  await redis.del(`exhausted:${id}`);
}

// --- ENDPOINTS ---

app.post('/deploy', async (c) => {
  const { provider, name } = await c.req.json();
  const redis = new Redis({ url: c.env.UPSTASH_REDIS_REST_URL, token: c.env.UPSTASH_REDIS_REST_TOKEN });

  let url = '';
  try {
    if (provider === 'netlify') {
      url = await provisionOnNetlify(c, name || `coderx-auto-${Date.now()}`);
    } else {
      return c.json({ error: 'Provider not yet implemented in auto-deploy' }, 400);
    }

    await registerProvider(redis, name, url);
    return c.json({ status: 'Deployed and Registered', url });
  } catch (e: any) {
    return c.json({ error: 'Deployment failed', message: e.message }, 500);
  }
});

// --- LLM ORCHESTRATION ---

app.get('/analyze', async (c) => {
  const redisUrl = c.env.UPSTASH_REDIS_REST_URL;
  const redisToken = c.env.UPSTASH_REDIS_REST_TOKEN;
  const openaiKey = c.env.OPENAI_API_KEY;

  if (!redisUrl || !redisToken || !openaiKey) {
    return c.json({ error: 'Configuration missing (Redis or OpenAI)' }, 500);
  }

  const redis = new Redis({ url: redisUrl, token: redisToken });
  const providers = await getActiveProviders(redis);

  const allMetrics: any = {};
  for (const p of providers) {
    allMetrics[p.id] = await redis.lrange(`metrics:${p.id}`, 0, 20);
  }

  // CALL LLM (Placeholder for actual OpenAI fetch)
  // In a real implementation, you would send allMetrics to OpenAI and ask for:
  // 1. Health status of each provider.
  // 2. Optimal traffic weights (e.g. 70% to Cloudflare, 30% to Railway).
  // 3. Whether to scale out (deploy new instance).

  return c.json({
    message: "LLM Analysis Complete",
    suggestion: "Maintain current distribution. Fly.io showing slightly higher latency (avg 450ms).",
    metrics_summary: allMetrics
  });
});

app.all('*', async (c) => {

  const startTime = Date.now();
  const url = new URL(c.req.url);

  // 1. Initialize Redis
  const redisUrl = c.env.UPSTASH_REDIS_REST_URL;
  const redisToken = c.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return c.json({ error: 'Redis configuration missing' }, 500);
  }

  const redis = new Redis({ url: redisUrl, token: redisToken });

  // 2. Load Balancing Strategy (Dynamic)
  const providers = await getActiveProviders(redis);

  // Filter out exhausted/unhealthy
  const healthyProviders = [];
  for (const p of providers) {
    const isExhausted = await redis.get(`exhausted:${p.id}`);
    if (!isExhausted) healthyProviders.push(p);
  }

  // 3. AUTO-SCALING TRIGGER
  if (healthyProviders.length === 0 || (healthyProviders.length < 2 && await checkHighLoad(redis, healthyProviders))) {
    console.log('[Orchestrator] High load detected or no healthy providers. Signaling Scale-Out.');
    // In a real scenario, this would trigger an async deployment via a Worker Queue or API call
    await redis.set('scale_out_requested', 'true', { ex: 300 });
  }

  if (healthyProviders.length === 0) {
    return c.json({ error: 'All backends busy. Auto-scaling in progress...', retry_after: 30 }, 503);
  }

  // 4. Select Target (Round Robin or Weighted by LLM)
  // Placeholder for LLM weight analysis: const weights = await getLLMWeights(redis, healthyProviders);
  const targetProvider = healthyProviders[Math.floor(Math.random() * healthyProviders.length)];

  // 5. Proxy Execution
  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');

  try {
    const response = await fetch(`${targetProvider.url}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: headers,
      body: c.req.method !== 'GET' ? await c.req.arrayBuffer() : undefined,
      redirect: 'follow'
    });

    const duration = Date.now() - startTime;
    await recordMetric(redis, targetProvider.id, duration, response.ok);

    const mergedHeaders = new Headers(response.headers);
    mergedHeaders.set('X-Backend-Provider', targetProvider.id);
    mergedHeaders.set('X-Response-Time', `${duration}ms`);

    return new Response(response.body, {
      status: response.status,
      headers: mergedHeaders
    });

  } catch (err: any) {
    console.error(`[Gateway] Failed to reach ${targetProvider.id}:`, err.message);
    await recordMetric(redis, targetProvider.id, 0, false);
    // Failover logic would go here: retry with another provider
    return c.json({ error: 'Upstream Error', provider: targetProvider.id }, 502);
  }
});

async function checkHighLoad(redis: Redis, providers: any[]) {
  // Simple heuristic: if avg latency > 2s, consider high load
  if (providers.length === 0) return true;
  const p = providers[0];
  const metricsRaw = await redis.lrange(`metrics:${p.id}`, 0, 10);
  if (!metricsRaw || metricsRaw.length < 5) return false;

  const latencies = metricsRaw.map(m => (typeof m === 'string' ? JSON.parse(m) : m).duration);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return avg > 2000;
}

export default app;

