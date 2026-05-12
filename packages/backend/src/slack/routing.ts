import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { boltApp } from "./bolt-app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Stakeholder = {
  name: string;
  slack_id: string;
  categories: string[];
};

type RoutingConfig = {
  stakeholders: Stakeholder[];
  default_slack_id: string;
};

function loadConfig(): RoutingConfig {
  const configPath = join(__dirname, "../../routing-config.json");
  return JSON.parse(readFileSync(configPath, "utf-8")) as RoutingConfig;
}

export function getRoutingConfig(): RoutingConfig {
  return loadConfig();
}

// Find the best stakeholder for a given category using fuzzy keyword matching.
export function resolveStakeholder(category: string | null): { name: string; slack_id: string } {
  const config = loadConfig();
  if (!category) {
    return { name: "Default Reviewer", slack_id: config.default_slack_id };
  }

  const normalized = category.toLowerCase();
  for (const stakeholder of config.stakeholders) {
    if (stakeholder.categories.some((c) => normalized.includes(c) || c.includes(normalized))) {
      return { name: stakeholder.name, slack_id: stakeholder.slack_id };
    }
  }

  return { name: "Default Reviewer", slack_id: config.default_slack_id };
}

export type SlackUser = {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
};

// Search Slack workspace users by name — used for routing overrides.
export async function searchSlackUsers(query: string): Promise<SlackUser[]> {
  const result = await boltApp.client.users.list({ limit: 200 });
  const members = result.members ?? [];
  const q = query.toLowerCase();

  return members
    .filter((m) => {
      if (m.deleted || m.is_bot || m.id === "USLACKBOT") return false;
      const realName = (m.profile?.real_name ?? "").toLowerCase();
      const displayName = (m.profile?.display_name ?? "").toLowerCase();
      const userName = (m.name ?? "").toLowerCase();
      return realName.includes(q) || displayName.includes(q) || userName.includes(q);
    })
    .slice(0, 5)
    .map((m) => ({
      id: m.id!,
      name: m.name ?? "",
      real_name: m.profile?.real_name ?? "",
      display_name: m.profile?.display_name ?? "",
    }));
}
