import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const agentSetupSlug = ["agents-setup"] as const;

export function isAgentSetupSlug(slug: string[] | undefined) {
  return slug?.length === 1 && slug[0] === agentSetupSlug[0];
}

export function readAgentSetupMarkdown() {
  return readFile(join(process.cwd(), "content/agents-setup.md"), "utf8");
}
