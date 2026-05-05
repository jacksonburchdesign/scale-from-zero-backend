import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import { verify } from "@octokit/webhooks-methods";

import * as logger from "firebase-functions/logger";

const githubSecret = defineSecret("GITHUB_WEBHOOK_SECRET");

export const githubAppWebhook = onRequest({ secrets: [githubSecret] }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const signature = req.headers["x-hub-signature-256"] as string;
    if (!signature) {
      logger.error("Missing signature");
      res.status(401).send("Unauthorized");
      return;
    }

    // Verify the webhook signature
    const rawBody = req.rawBody.toString('utf8');
    const secretValue = githubSecret.value();
    
    try {
      const isValid = await verify(secretValue, rawBody, signature);
      if (!isValid) {
        logger.error("Invalid signature");
        res.status(401).send("Unauthorized");
        return;
      }
    } catch (error) {
      logger.error("Signature verification failed", error);
      res.status(500).send("Verification Error");
      return;
    }

    const eventType = req.headers["x-github-event"];
    
    if (eventType === "ping" || eventType === "installation" || eventType === "installation_repositories") {
      res.status(200).send("Acknowledged");
      return;
    }

    if (eventType !== "push") {
      res.status(200).send("Event ignored");
      return;
    }

    const payload = req.body;
    const repoFullName = payload.repository?.full_name;
    const commits = payload.commits || [];

    if (!repoFullName) {
      res.status(400).send("Missing repository info");
      return;
    }

    if (commits.length === 0) {
      res.status(200).send("No commits in push");
      return;
    }

    // Pass all commit messages
    const rawCommits = commits.map((c: any) => c.message.trim()).join("\n- ");
    
    // Find project(s) in Firestore that have this repo mapped in connectedRepos array
    const db = getFirestore();
    const projectsRef = db.collection("projects");
    
    // Check both legacy `githubRepoFullName` (for backwards compatibility if needed)
    // and the new `connectedRepos` array.
    const snapshot = await projectsRef.where("connectedRepos", "array-contains", repoFullName).get();

    if (snapshot.empty) {
      logger.warn(`No project found for repo: ${repoFullName}`);
      res.status(404).send("Project not found");
      return;
    }

    // Save to Firestore as a draft for all associated projects
    for (const doc of snapshot.docs) {
      const projectId = doc.id;
      const ownerId = doc.data().ownerId;

      await db.collection("projects").doc(projectId).collection("changelogs").add({
        status: "raw-commit",
        rawCommit: rawCommits,
        createdAt: new Date(),
        ownerId: ownerId,
        sourceRepo: repoFullName
      });
    }

    res.status(200).send("Raw commits saved to project changelogs");
  } catch (error) {
    logger.error("Error processing github webhook:", error);
    res.status(500).send("Internal Error");
  }
});
