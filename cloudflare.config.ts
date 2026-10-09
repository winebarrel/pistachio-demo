import { bindings, defineConfig, defineContainer, exports } from "cf/config";

// Runs pista. The name is the one wrangler gave the application
// (<worker>-<class name in lower case>), so deploys keep updating it.
const pista = defineContainer({
  name: "pistachio-demo-pistacontainer",
  image: { dockerfile: "./Dockerfile" },
  instanceType: "lite",
  maxInstances: 3,
});

export default defineConfig({
  worker: {
    name: "pistachio-demo",
    compatibilityDate: "2026-09-01",
    entrypoint: "src/index.ts",
    observability: {
      enabled: true,
    },
    env: {
      // SHARES holds shared schemas, keyed by share ID. USAGE holds the daily
      // count of AI calls. With no id here, each namespace is created on the
      // first deploy.
      SHARES: bindings.kv({}),
      USAGE: bindings.kv({}),
      PISTA: bindings.durableObject({
        worker: "pistachio-demo",
        exportName: "PistaContainer",
      }),
      // Workers AI writes the AI examples (POST /api/example) and fixes
      // (POST /api/fix).
      AI: bindings.ai({}),
      // AI calls per client address: 5 a minute. The namespace is any number
      // unique to this account.
      AI_LIMIT: bindings.rateLimit({
        namespace: "1001",
        simple: {
          limit: 5,
          period: 60,
        },
      }),
      // The page and the sample schemas are static assets (see
      // wrangler.config.ts). A request that matches no asset reaches the
      // Worker, which forwards /api/* to the container and serves the page
      // for a share link (/p/<id>).
      ASSETS: bindings.assets(),
    },
    exports: {
      PistaContainer: exports.durableObject({
        storage: "sqlite",
        container: pista,
      }),
    },
  },
  containers: [pista],
});
