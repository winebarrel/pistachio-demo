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
  explain: boolean;
  version: string;
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
    explain: b.explain === true,
    // Empty means the newest release at the time the link is opened.
    version:
      typeof b.version === "string" && /^[0-9A-Za-z.+-]{0,32}$/.test(b.version)
        ? b.version
        : "",
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

// The model behind the AI buttons, and the most text one call may write. An
// example is two short schemas and a fix one schema file, so the caps keep
// each call cheap.
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EXAMPLE_MAX_TOKENS = 1500;
const FIX_MAX_TOKENS = 4096;

// AI calls a day for all clients together, examples and fixes alike.
const AI_CALLS_PER_DAY = 1000;

// Largest pair of schemas, with the error, a fix request may send. The model
// reads all of it and writes one file back, so the cost grows with it.
const MAX_FIX_BYTES = 24 * 1024;

// Each call draws a subject and a change from these lists, so examples vary
// and each one shows something pista does.
const EXAMPLE_SUBJECTS = [
  "a blog",
  "an online shop",
  "a task tracker",
  "a library",
  "a chat app",
  "a clinic's appointments",
  "a school's courses",
  "a hotel's bookings",
  "an event ticketing site",
  "a recipe site",
  "a fleet of delivery vans",
  "a support desk",
];
const EXAMPLE_CHANGES = [
  "add a column with a default and a NOT NULL constraint",
  "add a new table with a foreign key to an existing one",
  "add an index and a unique constraint",
  "add a CHECK constraint and change a column's type",
  "add a value to an enum type and use it as a column default",
  "add a view that joins two tables",
  "add a partial index and a composite index",
  "add a generated column",
  "add a domain type and use it for a column",
  "change a foreign key to ON DELETE CASCADE",
];

const EXAMPLE_PROMPT = `You write examples for pistachio, a tool that diffs two PostgreSQL schemas and prints the DDL that turns the current one into the desired one.
Answer with JSON: {"summary": ..., "current": ..., "desired": ...}.
- current: a small schema of 2 to 4 tables, as CREATE statements only. No INSERT, no CREATE EXTENSION, no CREATE SCHEMA, no GRANT, no comments.
- desired: the same schema with the change applied, written as the full schema again, not as ALTER statements. Right above each statement or column the change adds or modifies, put a comment on a line of its own, written as /* ... */ and never with --, that says in one sentence what changed there. No other comments.
- summary: one short English sentence saying what changed.
Use valid PostgreSQL 17 syntax and lower-case identifiers. Start every statement at the beginning of a line and leave a blank line between statements.
Order the statements so that each one comes after every object it refers to: types and domains first, then tables, each table after the tables its foreign keys reference. Put each CREATE INDEX right after the CREATE TABLE of the table it is on, and each view after all the tables it reads. The comment for a statement goes right above that statement, not above another one.`;

const FIX_PROMPT = `You fix schema files for pistachio, a tool that diffs two PostgreSQL schemas, current.sql and desired.sql, and prints the DDL that turns the current one into the desired one. The user sends both files and the error pistachio printed.
Fix the file the error is about, and only what causes the error. pistachio reads CREATE statements and COMMENT ON only: no INSERT, no ALTER, no CREATE EXTENSION, no GRANT. A statement must come after every object it refers to.
Keep everything else exactly as it is: the other statements, the comments, the spelling, the case, the blank lines and the indentation.
Answer with JSON: {"summary": ..., "file": ..., "sql": ...}.
- file: "current.sql" or "desired.sql", the file you fixed.
- sql: that file in full, with the fix.
- summary: one short English sentence saying what you fixed.`;

// Asks the model for a JSON object with the given string fields. Returns
// null when the call fails or the answer lacks one of them.
async function askAi(
  env: Env,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  fields: string[],
): Promise<Record<string, string> | null> {
  let answer: unknown;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: Object.fromEntries(
            fields.map((f) => [f, { type: "string" }]),
          ),
          required: fields,
        },
      },
    });
    // In JSON mode the answer may come parsed or as text.
    const response = (res as { response?: unknown }).response;
    answer = typeof response === "string" ? JSON.parse(response) : response;
  } catch (e) {
    console.error("AI call failed", e);
    return null;
  }
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as Record<string, unknown>;
  for (const f of fields) {
    if (typeof a[f] !== "string" || !(a[f] as string).trim()) return null;
  }
  return a as Record<string, string>;
}

// Every AI call costs Workers AI time, so one address gets a few a minute
// and all clients together get AI_CALLS_PER_DAY a day, counted per UTC date.
// KV is not atomic and a read can be up to a minute stale, so calls at the
// same moment may go a little over. Returns the answer to send when the call
// is not allowed, and counts it when it is.
async function useAiQuota(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AI_LIMIT.limit({ key: ip });
  if (!success) {
    return json({ error: "Too many AI requests. Wait a minute." }, 429);
  }

  const key = `ai-count:${new Date().toISOString().slice(0, 10)}`;
  const count = Number(await env.USAGE.get(key)) || 0;
  if (count >= AI_CALLS_PER_DAY) {
    return json(
      { error: "The AI is used up for today. Try again after 00:00 UTC." },
      429,
    );
  }
  // The count is kept two days, long enough to outlive its date.
  await env.USAGE.put(key, String(count + 1), {
    expirationTtl: 2 * 24 * 60 * 60,
  });
  return null;
}

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

// Has the model write a current and a desired schema that differ by one
// change. The page fills its editors with them and runs the diff.
async function example(request: Request, env: Env): Promise<Response> {
  const refused = await useAiQuota(request, env);
  if (refused) return refused;

  const a = await askAi(
    env,
    EXAMPLE_PROMPT,
    `The schema is for ${pick(EXAMPLE_SUBJECTS)}. The change: ${pick(EXAMPLE_CHANGES)}.`,
    EXAMPLE_MAX_TOKENS,
    0.7,
    ["summary", "current", "desired"],
  );
  if (!a) {
    return json(
      { error: "The AI could not write an example. Try again." },
      502,
    );
  }
  // The model often indents every statement after the first. pista fmt
  // indents the lines inside a statement but leaves where each statement
  // starts, so the indentation is removed here and the page formats the
  // result.
  const dedent = (s: string) =>
    `${s
      .trim()
      .split("\n")
      .map((line) => line.trimStart())
      .join("\n")}\n`;
  return json({
    summary: a.summary.trim(),
    current: dedent(a.current),
    desired: dedent(a.desired),
  });
}

// Has the model fix the schema file pista reported an error in. The page
// puts the file it returns in that editor and runs the diff again.
async function fix(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_FIX_BYTES) {
    return json(
      {
        error: `The schemas are too large for the AI to fix (limit ${MAX_FIX_BYTES / 1024} KiB).`,
      },
      413,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid request" }, 400);
  }
  const { current, desired, error } = body ?? {};
  if (
    typeof current !== "string" ||
    typeof desired !== "string" ||
    typeof error !== "string"
  ) {
    return json({ error: "invalid request" }, 400);
  }

  const refused = await useAiQuota(request, env);
  if (refused) return refused;

  const a = await askAi(
    env,
    FIX_PROMPT,
    `current.sql:\n${current}\n\ndesired.sql:\n${desired}\n\nThe error:\n${error}`,
    FIX_MAX_TOKENS,
    0.2,
    ["summary", "file", "sql"],
  );
  if (!a || (a.file !== "current.sql" && a.file !== "desired.sql")) {
    return json({ error: "The AI could not fix it. Try again." }, 502);
  }
  return json({
    summary: a.summary.trim(),
    file: a.file,
    sql: `${a.sql.replace(/\s+$/, "")}\n`,
  });
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
    if (url.pathname === "/api/example" && request.method === "POST") {
      return example(request, env);
    }
    if (url.pathname === "/api/fix" && request.method === "POST") {
      return fix(request, env);
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
