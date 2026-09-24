import { Container, getRandom } from "@cloudflare/containers";

// Number of container instances requests are spread over. Keep it at or
// below max_instances in wrangler.jsonc.
const INSTANCES = 3;

export class PistaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      // Every request is independent (pista diff reads no database), so
      // any instance can serve it.
      const container = await getRandom(env.PISTA, INSTANCES);
      return container.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
