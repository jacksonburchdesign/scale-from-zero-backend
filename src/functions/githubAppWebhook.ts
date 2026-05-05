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

    let aiTechnicalSummary = "Code update pushed.";
    let aiNonTechnicalSummary = "A new update was pushed to the repository.";
    let themeCategory = "Feature";
    let isTrivial = false;

    // Process with Vertex AI
    try {
      const { VertexAI } = await import("@google-cloud/vertexai");
      const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
      const generativeModel = vertexAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: { responseMimeType: "application/json" }
      });

      const prompt = `
        You are an expert product marketer and lead engineer analyzing commit messages.
        Determine if the push contains meaningful updates or just trivial changes (like "typo fix", "merge main", "bump dependencies").
        If the commits are entirely trivial, set "isTrivial" to true.
        Otherwise, synthesize the meaningful commits.
        
        Respond STRICTLY with a valid JSON object matching this exact schema:
        {
          "isTrivial": boolean,
          "technicalSummary": "A detailed, professional, developer-focused summary of the architecture or code changes (2-4 sentences). Avoid generic phrases. (Leave empty if trivial)",
          "nonTechnicalSummary": "A high-level, business-value summary for non-technical users that avoids technical jargon (2-3 sentences). Focus on what value was created. (Leave empty if trivial)",
          "themeCategory": "Must be EXACTLY one of: Feature, Fix, Polish, Infra, Security"
        }

        Raw Commits:
        - ${rawCommits}
      `;

      const result = await generativeModel.generateContent(prompt);
      const response = await result.response;
      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

      try {
        const parsed = JSON.parse(text);
        if (parsed.isTrivial) {
          isTrivial = true;
        } else {
          if (parsed.technicalSummary) aiTechnicalSummary = parsed.technicalSummary;
          if (parsed.nonTechnicalSummary) aiNonTechnicalSummary = parsed.nonTechnicalSummary;
          if (parsed.themeCategory) themeCategory = parsed.themeCategory;
        }
      } catch (e) {
        logger.error("Failed to parse JSON from Vertex AI", e, text);
      }
    } catch (error) {
      logger.error("Vertex AI Error:", error);
    }

    if (isTrivial) {
      res.status(200).send("Ignored: Commits were trivial");
      return;
    }

    // Save to Firestore as a draft for all associated projects
    for (const doc of snapshot.docs) {
      const projectId = doc.id;
      const ownerId = doc.data().ownerId;

      await db.collection("projects").doc(projectId).collection("changelogs").add({
        status: "draft",
        technicalSummary: aiTechnicalSummary,
        nonTechnicalSummary: aiNonTechnicalSummary,
        themeCategory: themeCategory,
        rawCommit: rawCommits,
        createdAt: new Date(),
        ownerId: ownerId,
        sourceRepo: repoFullName
      });
    }

    res.status(200).send("Changelog draft created from GitHub push");
  } catch (error) {
    logger.error("Error processing github webhook:", error);
    res.status(500).send("Internal Error");
  }
});
