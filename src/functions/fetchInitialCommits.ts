import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { App } from "octokit";

const githubAppIdSecret = defineSecret("GITHUB_APP_ID");
const githubAppPrivateKeySecret = defineSecret("GITHUB_APP_PRIVATE_KEY");

export const fetchInitialCommits = onCall({ 
  secrets: [githubAppIdSecret, githubAppPrivateKeySecret],
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to fetch commits.");
  }

  const { projectId } = request.data;
  if (!projectId) {
    throw new HttpsError("invalid-argument", "Missing projectId.");
  }

  const db = getFirestore();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    throw new HttpsError("not-found", "Project not found");
  }

  const projectData = projectSnap.data();
  if (projectData?.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only project owner can fetch commits.");
  }

  const installationId = projectData?.installationId;
  const connectedRepos: string[] = projectData?.connectedRepos || [];

  if (!installationId || connectedRepos.length === 0) {
    throw new HttpsError("failed-precondition", "Project is not connected to any GitHub repositories or missing installationId.");
  }

  const appId = githubAppIdSecret.value();
  const privateKey = githubAppPrivateKeySecret.value().replace(/\\n/g, '\n'); // Handle potential escaped newlines

  try {
    const app = new App({
      appId: appId,
      privateKey: privateKey,
    });

    const octokit = await app.getInstallationOctokit(installationId);
    let commitsAdded = 0;

    for (const repoFullName of connectedRepos) {
      const [owner, repo] = repoFullName.split('/');
      
      try {
        const { data: commits } = await octokit.rest.repos.listCommits({
          owner,
          repo,
          per_page: 30 // Fetch last 30 commits
        });

        const batch = db.batch();
        const changelogsRef = projectRef.collection("changelogs");

        for (const commitData of commits) {
          const sha = commitData.sha;
          const message = commitData.commit.message.trim();
          
          if (!message) continue;

          const docRef = changelogsRef.doc(sha); // Use SHA to prevent duplicates
          
          batch.set(docRef, {
            status: "raw-commit",
            rawCommit: message,
            sourceRepo: repoFullName,
            createdAt: new Date(commitData.commit.author?.date || new Date().toISOString()),
            ownerId: request.auth.uid
          }, { merge: true }); // Merge ensures we don't overwrite blindly if it has extra metadata, though here it just guarantees idempotent writes

          commitsAdded++;
        }

        await batch.commit();
      } catch (repoError) {
        logger.error(`Failed to fetch commits for repo ${repoFullName}`, repoError);
        // Continue to the next repo instead of failing the entire operation
      }
    }

    return { success: true, message: `Successfully fetched and saved ${commitsAdded} recent commits.`, count: commitsAdded };

  } catch (error) {
    logger.error("GitHub API Error:", error);
    throw new HttpsError("internal", "Failed to fetch initial commits from GitHub.");
  }
});
