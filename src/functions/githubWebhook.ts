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

  // Extract commit messages
  const commitMessages = commits.map((c: any) => c.message).join("\n- ");
  
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

  // Process with Vertex AI
  try {
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-1.5-flash",
    });

    const prompt = `
      You are an expert product marketer communicating to investors and non-technical stakeholders.
      Rewrite the following rough developer changelog into a polished, positive, high-conversion summary.
      Focus on business value, traction, and user momentum.
      Keep it brief, under 65 characters per line if possible, and highly legible.
      
      Raw Changelog:
      - ${commitMessages}
    `;

    const result = await generativeModel.generateContent(prompt);
    const response = await result.response;
    const aiText = response.candidates?.[0]?.content?.parts?.[0]?.text || "Update from recent code pushes.";

    // Save to Firestore as a draft
    await db.collection("projects").doc(projectId).collection("changelogs").add({
      status: "draft",
      content: aiText,
      rawCommits: commitMessages,
      createdAt: new Date(),
      ownerId: ownerId, // Important for security rules if they check owner
    });

    res.status(200).send("Changelog draft created");
  } catch (error) {
    logger.error("AI Generation or DB Error:", error);
    res.status(500).send("Failed to generate AI changelog");
  }
});
