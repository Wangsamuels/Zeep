// Zeep relay on Cloudflare Workers (free plan). The browser talks to this Worker; the Worker
// forwards to Heroku with the relay secret and ONLY an allowlist of headers, so no client IP,
// user agent or language ever reaches Heroku (whose router logs X-Forwarded-For).
//
// Config (wrangler.toml / dashboard): ORIGIN = https://<your-heroku-app>.herokuapp.com
// Secret (never in code):            wrangler secret put RELAY_SHARED_SECRET
// The Worker itself keeps no logs (observability disabled in wrangler.toml).

const PASS = new Set([
  'content-type', 'accept', 'origin', 'cache-control',
  'access-control-request-method', 'access-control-request-headers', // CORS preflight
  'x-vault-id', 'x-vault-auth',
]);
const passes = (name) => PASS.has(name) || name === 'x-zeep-proof' || /^x-zeep-proof-\d{1,2}$/.test(name);

export default {
  async fetch(request, env) {
    if (!env.ORIGIN || !env.RELAY_SHARED_SECRET) return new Response('relay not configured', { status: 500 });
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.ORIGIN);

    const headers = new Headers();
    for (const [name, value] of request.headers) if (passes(name.toLowerCase())) headers.set(name, value);
    headers.set('x-zeep-relay', env.RELAY_SHARED_SECRET);

    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: 'half', // stream the request body (needed for streaming bodies per the fetch spec)
      redirect: 'manual',
    });
    // Stream the response straight through (AI replies are server-sent events).
    const out = new Headers(upstream.headers);
    out.delete('set-cookie');
    out.delete('via');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
