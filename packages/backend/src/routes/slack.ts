import type { FastifyPluginAsync } from "fastify";
import { getRoutingConfig, searchSlackUsers } from "../slack/routing.js";

export const slackRoutes: FastifyPluginAsync = async (app) => {
  // Returns the current routing config so /decide can show suggested owners.
  app.get("/slack/routing-config", async () => {
    return getRoutingConfig();
  });

  // Search Slack users by name — used when overriding a suggested reviewer.
  app.get<{ Querystring: { q: string } }>("/slack/users/search", async (req, reply) => {
    const { q } = req.query;
    if (!q?.trim()) return reply.badRequest("q is required");
    const users = await searchSlackUsers(q.trim());
    return { users };
  });
};
