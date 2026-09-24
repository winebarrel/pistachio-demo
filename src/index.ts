import { Container, getRandom } from "@cloudflare/containers";

// Number of container instances requests are spread over. Keep it at or
// below max_instances in wrangler.jsonc.
const INSTANCES = 3;

// Largest share the Worker stores, as the JSON body it receives.
const MAX_SHARE_BYTES = 128 * 1024;

// A share ID is the start of the SHA-256 of what it holds, base64url
// encoded: 11 characters, 66 bits. The same input always gets the same
// link, and storing it twice is harmless.
const ID_LENGTH = 11;
const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export class PistaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}

interface Share {
  current: string;
  desired: string;
  allow_drop: string[];
  manage_routine: boolean;
  bulk_alter: boolean;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Keeps only the fields the page reads, with the types it expects.
function parseShare(body: unknown): Share | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.current !== "string" || typeof b.desired !== "string")
    return null;
  const allowDrop = Array.isArray(b.allow_drop)
    ? b.allow_drop.filter((v) => typeof v === "string")
    : [];
  return {
    current: b.current,
    desired: b.desired,
    allow_drop: allowDrop,
    manage_routine: b.manage_routine === true,
    bulk_alter: b.bulk_alter === true,
  };
}

async function shareId(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replaceAll("+", "-").replaceAll("/", "_").slice(0, ID_LENGTH);
}

async function createShare(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_SHARE_BYTES) {
    return json(
      {
        error: `The schemas are too large to share (limit ${MAX_SHARE_BYTES / 1024} KiB).`,
      },
      413,
    );
  }
  let share: Share | null;
  try {
    share = parseShare(JSON.parse(text));
  } catch {
    share = null;
  }
  if (!share) return json({ error: "invalid request" }, 400);

  const value = JSON.stringify(share);
  const id = await shareId(value);
  await env.SHARES.put(id, value);
  return json({ id });
}

async function readShare(id: string, env: Env): Promise<Response> {
  if (!ID_PATTERN.test(id)) return json({ error: "not found" }, 404);
  const value = await env.SHARES.get(id);
  if (value === null) return json({ error: "not found" }, 404);
  return new Response(value, {
    headers: { "Content-Type": "application/json" },
  });
}

// Wait before each retry. An instance that just died can fail to start
// again at once, so the retries are spaced out rather than immediate.
const RETRY_DELAYS_MS = [500, 1500];

// The server in the container answers every request with 200 or 400, pista
// errors included, so a 5xx comes from the container layer: an instance that
// failed to start or dropped the connection. Every request is independent
// (pista diff reads no database), so it is sent again, to a random instance,
// with the same body.
async function forwardToContainer(
  request: Request,
  env: Env,
): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : null;
  for (let attempt = 0; ; attempt++) {
    const container = await getRandom(env.PISTA, INSTANCES);
    const res = await container.fetch(new Request(request, { body }));
    if (res.status < 500 || attempt === RETRY_DELAYS_MS.length) return res;
    console.warn(
      `container answered ${res.status} (attempt ${attempt + 1}): ${await res.clone().text()}`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
    );
  }
}

// The repository the page links to, and how long its star count is cached.
// The Worker fetches the count, not the page, and keeps it in the Cache API,
// so GitHub sees about one request an hour per data center.
const REPO = "winebarrel/pistachio";
const STARS_TTL_SECONDS = 3600;
const STARS_CACHE_KEY = `https://stars.cache.internal/${REPO}`;

// GITHUB_TOKEN is an optional secret (wrangler secret put GITHUB_TOKEN).
// Without it GitHub allows 60 requests an hour per IP address, and Workers
// share their outgoing addresses, so the count may often be unavailable.
async function stars(
  env: Env & { GITHUB_TOKEN?: string },
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(STARS_CACHE_KEY);
  if (cached) return cached;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pistachio-demo",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers });
  // A failure is not cached, so the next request tries GitHub again.
  if (!res.ok) return json({ error: `GitHub answered ${res.status}` }, 502);
  const repo = (await res.json()) as { stargazers_count?: unknown };
  if (typeof repo.stargazers_count !== "number") {
    return json({ error: "no star count" }, 502);
  }

  const answer = Response.json(
    { stars: repo.stargazers_count },
    { headers: { "Cache-Control": `public, max-age=${STARS_TTL_SECONDS}` } },
  );
  ctx.waitUntil(cache.put(STARS_CACHE_KEY, answer.clone()));
  return answer;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/share" && request.method === "POST") {
      return createShare(request, env);
    }
    if (url.pathname === "/api/stars" && request.method === "GET") {
      return stars(env, ctx);
    }
    if (url.pathname.startsWith("/api/share/") && request.method === "GET") {
      return readShare(url.pathname.slice("/api/share/".length), env);
    }

    if (url.pathname.startsWith("/api/")) {
      return forwardToContainer(request, env);
    }

    // A share link is the page itself; the page loads the share by its ID.
    if (/^\/p\/[^/]+$/.test(url.pathname)) {
      return env.ASSETS.fetch(new URL("/", url));
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
