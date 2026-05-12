import { prisma } from "../db.js";

// Find-or-create a Repo row for the given path string.
// Used by every write path that receives a repo_path/linked_repo string so that
// the repoId FK is always populated for proper per-repo isolation.
export async function upsertRepo(path: string): Promise<string> {
  const repo = await prisma.repo.upsert({
    where: { path },
    create: { path },
    update: {},
    select: { id: true },
  });
  return repo.id;
}

// Resolve a repo path string → repoId for use in query filters.
// Returns null if the path is unknown (no rows will match, caller can widen or skip).
export async function resolveRepoId(path: string): Promise<string | null> {
  const repo = await prisma.repo.findUnique({ where: { path }, select: { id: true } });
  return repo?.id ?? null;
}
