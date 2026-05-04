import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import { verify } from "@octokit/webhooks-methods";
import { VertexAI } from "@google-cloud/vertexai";
import * as logger from "firebase-functions/logger";

const githubSecret = defineSecret("GITHUB_WEBHOOK_SECRET");

export const githubWebhook = onRequest({ secrets: [githubSecret] }, async (req, res) => {
  // Only accept POST requests
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
  
  if (eventType === "ping") {
    res.status(200).send("Pong");
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

  // Extract sfz commit messages
  const sfzCommits = commits.filter((c: any) => c.message?.toLowerCase().startsWith("sfz:"));
  
  if (sfzCommits.length === 0) {
    res.status(200).send("Ignored: No sfz: commits found");
    return;
  }

  const rawCommits = sfzCommits.map((c: any) => c.message.substring(4).trim()).join("\n- ");
  
  // Find project in Firestore
  const db = getFirestore();
  const projectsRef = db.collection("projects");
  const snapshot = await projectsRef.where("githubRepoFullName", "==", repoFullName).get();

  if (snapshot.empty) {
    logger.warn(`No project found for repo: ${repoFullName}`);
    res.status(404).send("Project not found");
    return;
  }

  // For simplicity, grab the first matched project
  const projectDoc = snapshot.docs[0];
  const projectId = projectDoc.id;
  const ownerId = projectDoc.data().ownerId;

  let aiTechnicalSummary = "Code update pushed.";
  let aiNonTechnicalSummary = "A new update was pushed to the repository.";
  let themeCategory = "Feature";

  // Process with Vertex AI
  try {
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert product marketer and lead engineer. 
      Analyze the following developer commit messages and output a JSON object containing three fields:
      - "technicalSummary": A professional, developer-focused summary of the changes.
      - "nonTechnicalSummary": A high-level, business-value summary for recruiters or investors.
      - "themeCategory": Categorize the update into exactly one of these strings: "Feature", "Fix", "Polish", "Infra", "Security".

      Raw Commits:
      ${rawCommits}
    `;

    const result = await generativeModel.generateContent(prompt);
    const response = await result.response;
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    try {
      const parsed = JSON.parse(text);
      if (parsed.technicalSummary) aiTechnicalSummary = parsed.technicalSummary;
      if (parsed.nonTechnicalSummary) aiNonTechnicalSummary = parsed.nonTechnicalSummary;
      if (parsed.themeCategory) themeCategory = parsed.themeCategory;
    } catch (e) {
      logger.error("Failed to parse JSON from Vertex AI", e, text);
    }
  } catch (error) {
    logger.error("Vertex AI Error:", error);
  }

  // Save to Firestore as a draft
  await db.collection("projects").doc(projectId).collection("changelogs").add({
    status: "draft",
    technicalSummary: aiTechnicalSummary,
    nonTechnicalSummary: aiNonTechnicalSummary,
    themeCategory: themeCategory,
    rawCommit: rawCommits,
    createdAt: new Date(),
    ownerId: ownerId,
  });

  res.status(200).send("Changelog draft created from GitHub push");
} catch (error) {
  logger.error("Error processing github webhook:", error);
  res.status(500).send("Internal Error");
}
});
