import * as crypto from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

const vercelSecret = defineSecret("VERCEL_WEBHOOK_SECRET");

export const vercelWebhook = onRequest({ secrets: [vercelSecret] }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const signature = req.headers["x-vercel-signature"] as string;
  if (!signature) {
    logger.error("Missing Vercel signature");
    res.status(401).send("Unauthorized");
    return;
  }

  const rawBody = req.rawBody.toString('utf8');
  const secretValue = vercelSecret.value();

  const hmac = crypto.createHmac("sha1", secretValue);
  const computedSignature = hmac.update(rawBody).digest("hex");

  if (signature !== computedSignature) {
    logger.error("Invalid Vercel signature");
    res.status(401).send("Unauthorized");
    return;
  }

  const payload = req.body;
  const projectId = req.query.projectId as string;

  if (!projectId) {
    logger.error("Missing projectId in query params");
    res.status(400).send("Missing projectId");
    return;
  }

  // Only care about deployment.succeeded
  if (payload.type !== "deployment.succeeded") {
    res.status(200).send("Event ignored");
    return;
  }

  const db = getFirestore();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    logger.warn(`Project not found: ${projectId}`);
    res.status(404).send("Project not found");
    return;
  }

  const deploymentUrl = payload.payload?.url || payload.payload?.deployment?.url || "";
  const githubCommitMessage = payload.payload?.deployment?.meta?.githubCommitMessage || "";
  
  if (!githubCommitMessage.toLowerCase().startsWith("sfz:")) {
    res.status(200).send("Ignored: Commit does not have sfz: prefix");
    return;
  }

  const rawCommit = githubCommitMessage.substring(4).trim();

  let aiTechnicalSummary = "Update deployed successfully.";
  let aiNonTechnicalSummary = "We just shipped a new update!";
  let themeCategory = "Feature";

  try {
    // We dynamically import VertexAI if we need to avoid heavy top-level imports, but let's just require it since we're in the webhook
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert product marketer and lead engineer. 
      Analyze the following developer commit message.
      
      Respond STRICTLY with a valid JSON object matching this exact schema:
      {
        "technicalSummary": "A detailed, professional, developer-focused summary of the architecture or code changes (2-4 sentences). Avoid generic phrases.",
        "nonTechnicalSummary": "A high-level, highly scannable business-value summary for investors, marketers, and recruiters. Format the output STRICTLY in Markdown. Start with a single catchy headline featuring an appropriate emoji. Follow this with 1 to 3 concise bullet points highlighting the business impact, traction, and value created. Bold the most important keywords.",
        "themeCategory": "Must be EXACTLY one of: Feature, Fix, Polish, Infra, Security"
      }

      Raw Commit:
      ${rawCommit}
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

  // Save draft changelog
  await db.collection("projects").doc(projectId).collection("changelogs").add({
    status: "draft",
    technicalSummary: aiTechnicalSummary,
    nonTechnicalSummary: aiNonTechnicalSummary,
    themeCategory: themeCategory,
    rawCommit: rawCommit,
    deploymentUrl: deploymentUrl,
    vercelStatus: "Success",
    createdAt: new Date(),
    ownerId: projectSnap.data()?.ownerId
  });

  // Update project doc with lastVercelDeploy for UI status
  await projectRef.update({
    lastVercelDeploy: new Date()
  });

  res.status(200).send("Vercel deployment processed and AI changelog generated");
});
