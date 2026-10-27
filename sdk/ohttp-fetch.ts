// A drop-in `fetch` that sends every Zeep API call through Oblivious HTTP.
//
//   const zfetch = ohttpFetch({ baseUrl: API_BASE, keyConfig: OHTTP_KEY_CONFIG });
//   const client = new ZeepClient({ baseUrl: API_BASE, fetch: zfetch, ... });
//   await zfetch(`${API_BASE}/v1/vault/items`, { headers: {...} });   // any other API call
//
// The relay sees the user's IP and an encrypted blob posted to /ohttp, nothing else: not the
// route, the headers, the body or the reply. Zeep's server sees the request but not the IP.
//
// `keyConfig` MUST come with the app (a build-time setting), never from the relay: whoever
// serves the key could swap it and read everything.
import {
  encodeRequest, OhttpError, parseKeyConfig, REQ_MEDIA, ResponseParser, ResponseReader, sealRequest,
  type Fields, type KeyConfig,
} from "./ohttp";

export interface OhttpFetchOptions {
  /** The relay's API base URL, e.g. https://zeep-relay-mainnet.<you>.workers.dev */
  baseUrl: string;
  /** Zeep's OHTTP key config (base64url), built into the app. */
  keyConfig: string | KeyConfig;
  /** The network fetch (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const enc = new TextEncoder();

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (typeof body === "string") return enc.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return enc.encode(body.toString());
  throw new OhttpError("unsupported request body for OHTTP");
}

export function ohttpFetch(o: OhttpFetchOptions): typeof fetch {
  const base = o.baseUrl.replace(/\/+$/, "");
  const key = typeof o.keyConfig === "string" ? parseKeyConfig(o.keyConfig) : o.keyConfig;
  const net = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let url: string;
    let method = init.method;
    let headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof Request !== "undefined" && input instanceof Request) {
      url = input.url;
      method ??= input.method;
      if (!init.headers) headers = new Headers(input.headers);
      if (body === undefined && input.body) body = await input.arrayBuffer();
    } else {
      url = String(input);
    }
    // Only Zeep API calls go through here; anything else is a bug that would leak in plain text.
    if (!url.startsWith(`${base}/`)) throw new OhttpError(`ohttpFetch only sends to ${base}`);
    const path = url.slice(base.length).replace(/^\/+/, "/");
    const fields: Fields = [];
    headers.forEach((v, k) => fields.push([k, v]));

    const msg = encodeRequest((method ?? "GET").toUpperCase(), path, fields, await bodyBytes(body));
    const { body: sealed, ctx, enc: encKey } = sealRequest(key, msg);
    const outer = await net(`${base}/ohttp`, {
      method: "POST",
      headers: { "content-type": REQ_MEDIA },
      body: sealed as BodyInit,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: init.signal,
    });
    // Errors from the relay or the gateway itself (not the inner API) come back as plain JSON.
    if (!outer.ok || !outer.body) return outer;

    const reader = outer.body.getReader();
    const chunks = new ResponseReader(ctx, encKey);
    const parser = new ResponseParser();
    let ready!: (v: void) => void;
    let failed!: (e: unknown) => void;
    const head = new Promise<void>((res, rej) => { ready = res; failed = rej; });
    let headDone = false;

    const content = new ReadableStream<Uint8Array>({
      async start(controller) {
        const feed = (pt: Uint8Array) => {
          const r = parser.push(pt);
          if (r.head && !headDone) { headDone = true; ready(); }
          for (const c of r.content) controller.enqueue(c);
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const pt of chunks.push(value)) feed(pt);
          }
          feed(chunks.end());
          if (!parser.complete) throw new OhttpError("response truncated");
          controller.close();
        } catch (e) {
          if (!headDone) failed(e);
          controller.error(e);
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });
    await head;
    const respHeaders = new Headers();
    for (const [k, v] of parser.headers) respHeaders.append(k, v);
    const status = parser.status;
    return new Response(NULL_BODY.has(status) ? null : content, { status, headers: respHeaders });
  }) as typeof fetch;
}

