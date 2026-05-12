import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const TrackBody = z.object({
  file_path: z.string().min(1),
  description: z.string().optional(),
});

const DriftBody = z.object({
  // Map of relative file path → ISO timestamp of last git commit for that file.
  // Passed by the client (VS Code extension or agent file) since only the client
  // has filesystem + git access.
  file_timestamps: z.record(z.string()),
});

// Resolve a repo by UUID or by path (convenience for agent file callers).
async function resolveRepo(idOrPath: string) {
  // Try UUID first
  const byId = await prisma.repo.findUnique({ where: { id: idOrPath } });
  if (byId) return byId;
  // Fall back to path lookup
  return prisma.repo.findUnique({ where: { path: idOrPath } });
}

export const artifactRoutes: FastifyPluginAsync = async (app) => {

  // List all tracked artifacts for a repo, with their linked decisions.
  app.get<{ Params: { id: string } }>("/repos/:id/artifacts", async (req, reply) => {
    const repo = await resolveRepo(req.params.id);
    if (!repo) return reply.notFound("Repo not found");

    const artifacts = await prisma.trackedArtifact.findMany({
      where: { repoId: repo.id },
      include: {
        links: {
          include: {
            decision: {
              select: {
                id: true,
                hexId: true,
                entryType: true,
                questionText: true,
                answer: true,
                createdAt: true,
                supersededById: true,
              },
            },
          },
          orderBy: { decision: { createdAt: "desc" } },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return artifacts.map((a) => ({
      artifact_id: a.id,
      file_path: a.filePath,
      description: a.description,
      created_at: a.createdAt.toISOString(),
      decisions: a.links.map((l) => ({
        decision_id: l.decision.id,
        hex_id: l.decision.hexId,
        entry_type: l.decision.entryType,
        question_text: l.decision.questionText,
        answer: l.decision.answer,
        created_at: l.decision.createdAt.toISOString(),
        superseded: !!l.decision.supersededById,
      })),
    }));
  });

  // Track a file — idempotent (upsert by repoId + filePath).
  app.post<{ Params: { id: string } }>("/repos/:id/artifacts", async (req, reply) => {
    const repo = await resolveRepo(req.params.id);
    if (!repo) return reply.notFound("Repo not found");

    const parsed = TrackBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const artifact = await prisma.trackedArtifact.upsert({
      where: { repoId_filePath: { repoId: repo.id, filePath: parsed.data.file_path } },
      create: {
        repoId: repo.id,
        filePath: parsed.data.file_path,
        description: parsed.data.description ?? null,
      },
      update: {
        description: parsed.data.description ?? undefined,
      },
    });

    return reply.code(201).send({
      artifact_id: artifact.id,
      file_path: artifact.filePath,
      description: artifact.description,
      created_at: artifact.createdAt.toISOString(),
    });
  });

  // Untrack a file.
  app.delete<{ Params: { id: string; artifactId: string } }>(
    "/repos/:id/artifacts/:artifactId",
    async (req, reply) => {
      const repo = await resolveRepo(req.params.id);
      if (!repo) return reply.notFound("Repo not found");

      const artifact = await prisma.trackedArtifact.findFirst({
        where: { id: req.params.artifactId, repoId: repo.id },
      });
      if (!artifact) return reply.notFound("Artifact not found");

      await prisma.trackedArtifact.delete({ where: { id: artifact.id } });
      return reply.code(204).send();
    }
  );

  // Drift detection — client passes file timestamps; backend returns artifacts
  // whose latest linked decision is newer than the file's last git commit.
  // POST (not GET) because the payload (file_timestamps map) can be large.
  app.post<{ Params: { id: string } }>("/repos/:id/artifacts/drift", async (req, reply) => {
    const repo = await resolveRepo(req.params.id);
    if (!repo) return reply.notFound("Repo not found");

    const parsed = DriftBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { file_timestamps } = parsed.data;

    const artifacts = await prisma.trackedArtifact.findMany({
      where: { repoId: repo.id },
      include: {
        links: {
          include: {
            decision: {
              select: {
                id: true,
                hexId: true,
                entryType: true,
                questionText: true,
                answer: true,
                createdAt: true,
                supersededById: true,
              },
            },
          },
          orderBy: { decision: { createdAt: "desc" } },
        },
      },
    });

    const drifted = [];

    for (const artifact of artifacts) {
      if (!artifact.links.length) continue;

      // Latest linked decision (links ordered desc by createdAt)
      const latestLink = artifact.links[0];
      const decisionTs = latestLink.decision.createdAt;

      // Client-provided timestamp for this file
      const fileTs = file_timestamps[artifact.filePath];
      if (!fileTs) continue; // file not in client's staged/tracked set — skip

      const fileDate = new Date(fileTs);
      if (isNaN(fileDate.getTime())) continue;

      if (decisionTs > fileDate) {
        drifted.push({
          artifact_id: artifact.id,
          file_path: artifact.filePath,
          description: artifact.description,
          file_last_committed_at: fileTs,
          latest_decision: {
            decision_id: latestLink.decision.id,
            hex_id: latestLink.decision.hexId,
            entry_type: latestLink.decision.entryType,
            question_text: latestLink.decision.questionText,
            answer: latestLink.decision.answer,
            created_at: latestLink.decision.createdAt.toISOString(),
            superseded: !!latestLink.decision.supersededById,
          },
        });
      }
    }

    return { drifted, total_tracked: artifacts.length };
  });
};
