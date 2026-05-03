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

  const deploymentUrl = payload.payload?.url;
  const projectName = payload.payload?.name;

  // Save draft changelog
  await db.collection("projects").doc(projectId).collection("changelogs").add({
    status: "draft",
    content: `Vercel Deployment Successful: A new version of ${projectName || "the app"} is live!\n\nCheck it out here: https://${deploymentUrl}`,
    rawCommits: `Deployment ID: ${payload.payload?.id}\nTarget: ${payload.payload?.target}`,
    createdAt: new Date(),
    ownerId: projectSnap.data()?.ownerId // For backwards compatibility
  });

  // Update project doc with lastVercelDeploy for UI status
  await projectRef.update({
    lastVercelDeploy: new Date()
  });

  res.status(200).send("Vercel deployment logged as draft");
});
