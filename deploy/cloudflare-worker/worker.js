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
// Light-wallet traffic (gRPC-web) for the in-app Zcash wallet, relayed under /lwd/ so the
// lightwalletd server never sees the user's IP next to their transparent address or the
// transactions they broadcast. It never carries the relay secret.
const LWD_PASS = new Set([
  'content-type', 'accept', 'origin', 'x-grpc-web', 'grpc-timeout',
  'access-control-request-method', 'access-control-request-headers',
]);
const passes = (name) => PASS.has(name) || name === 'x-zeep-proof' || /^x-zeep-proof-\d{1,2}$/.test(name);

async function lightwalletd(request, url, env) {
  // A gRPC-web proxy in front of lightwalletd (browsers can't speak raw gRPC). ChainSafe's
  // runs in front of zec.rocks and answers proper gRPC-web with CORS.
  const origin = env.LWD_ORIGIN || 'https://zcash-mainnet.chainsafe.dev';
  const path = url.pathname.slice(4).replace(/^\/+/, '/');
  // Only the CompactTxStreamer service: the relay is not an open proxy.
  if (!/^\/cash\.z\.wallet\.sdk\.rpc\.CompactTxStreamer\/[A-Za-z]+$/.test(path)) return new Response('not found', { status: 404 });
  const headers = new Headers();
  for (const [name, value] of request.headers) if (LWD_PASS.has(name.toLowerCase())) headers.set(name, value);
  const upstream = await fetch(new URL(path, origin), {
    method: request.method,
    headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? undefined : request.body,
    duplex: 'half',
    redirect: 'manual',
  });
  const out = new Headers(upstream.headers);
  for (const h of ['set-cookie', 'via', 'nel', 'report-to', 'reporting-endpoints', 'server-timing']) out.delete(h);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default {
  async fetch(request, env) {
    if (!env.ORIGIN || !env.RELAY_SHARED_SECRET) return new Response('relay not configured', { status: 500 });
    const url = new URL(request.url);
    if (env.ORIGIN.includes('REPLACE-')) return new Response('relay ORIGIN is still the placeholder in wrangler.toml', { status: 500 });
    if (url.pathname === '/lwd' || url.pathname.startsWith('/lwd/')) return lightwalletd(request, url, env);
    // Collapse leading slashes so "//v1/x" (a trailing slash in the frontend's API URL) can't
    // be read as a different host.
    // Only the two numeric paging parameters the API reads are forwarded. Anything else in
    // a query string would land in Heroku's router log, so it never leaves the Worker.
    const target = new URL(url.pathname.replace(/^\/+/, '/'), env.ORIGIN);
    for (const k of ['from', 'limit']) {
      const v = url.searchParams.get(k);
      if (v !== null && /^\d{1,9}$/.test(v)) target.searchParams.set(k, v);
    }

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
    // Heroku's router adds Network Error Logging headers. A browser that honours them sends
    // reports straight to nel.heroku.com from the user's own IP, bypassing this relay, so
    // they're removed along with anything else that could identify or track a user.
    for (const h of ['set-cookie', 'via', 'nel', 'report-to', 'reporting-endpoints', 'server-timing', 'alt-svc']) out.delete(h);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
