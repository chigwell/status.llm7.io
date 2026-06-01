import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

type MockModelMetrics = {
  success_200: number;
  errors: {
    total: number;
    "4xx": number;
    "5xx": number;
    timeouts: number;
  };
  status_429: number;
  tokens: {
    input: number;
    output: number;
  };
};

const mockModels = [
  "qwen3-235b",
  "kimi-k2.6",
  "minimax-m2.7",
  "mistral-small-3.2",
  "codestral-latest",
  "ministral-8b-2512",
  "GLM-4.6V-Flash",
  "devstral-small-2:24b-cloud",
  "deepseek-v4-flash",
  "deepseek-v3.1:671b-terminus",
];

function createMockPing() {
  const tick = Date.now() / 1000;
  const model_metrics_last_60s: Record<string, MockModelMetrics> = {};

  mockModels.forEach((model, index) => {
    const wave = (Math.sin(tick / (3 + index * 0.35)) + 1) / 2;
    const burst = index % 3 === 0 ? Math.max(0, Math.sin(tick / 5)) : 0;
    const success_200 = Math.max(0, Math.round(wave * (52 - index * 3)));
    const timeouts = Math.max(0, Math.round(burst * (index === 1 ? 22 : 4)));
    const status_429 = model === "GLM-4.6V-Flash" ? Math.round(wave * 6) : 0;
    const errors4xx = status_429;
    const errors5xx = Math.round(Math.max(0, Math.sin(tick / 11 + index)) * 2);
    const totalErrors = timeouts + errors4xx + errors5xx;

    model_metrics_last_60s[model] = {
      success_200,
      errors: {
        total: totalErrors,
        "4xx": errors4xx,
        "5xx": errors5xx,
        timeouts,
      },
      status_429,
      tokens: {
        input: Math.round(success_200 * (900 + index * 180) + wave * 6000),
        output: Math.round(success_200 * (110 + index * 22) + wave * 1200),
      },
    };
  });

  const active_requests_last_60s = Object.values(model_metrics_last_60s).reduce(
    (sum, metrics) => sum + metrics.success_200 + metrics.errors.total,
    0,
  );

  return {
    message: "pong",
    active_requests_last_60s,
    model_metrics_last_60s,
  };
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "llm7-mock-ping",
      configureServer(server) {
        server.middlewares.use("/mock-ping", (_request, response) => {
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(createMockPing()));
        });
      },
    },
  ],
  server: {
    proxy: {
      "/llm7-ping": {
        target: "https://api.llm7.io",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm7-ping/, ""),
      },
    },
  },
});
