import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { promptRoutes } from "./routes/prompts.js";
import { questionRoutes } from "./routes/questions.js";
import { decisionRoutes } from "./routes/decisions.js";
import { slackRoutes } from "./routes/slack.js";
import { boltApp } from "./slack/bolt-app.js";

const app = Fastify({ logger: { level: "info" } });

await app.register(cors);
await app.register(sensible);

await app.register(promptRoutes, { prefix: "/api" });
await app.register(questionRoutes, { prefix: "/api" });
await app.register(decisionRoutes, { prefix: "/api" });
await app.register(slackRoutes, { prefix: "/api" });

app.get("/health", async () => ({
  status: "ok",
  phase: 5,
  slack: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
  embeddings: !!(process.env.OPENAI_API_KEY),
}));

// Start Slack Socket Mode only if both tokens are present.
// Phase 1/2 work fully without Slack credentials.
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  await boltApp.start();
  app.log.info("Slack Bolt connected via Socket Mode");
} else {
  app.log.warn(
    "SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set — Slack routing is in stub mode"
  );
}

const port = parseInt(process.env.BACKEND_PORT ?? "3002", 10);
await app.listen({ port, host: "0.0.0.0" });
