import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

import * as logger from "firebase-functions/logger";

export const compileDailyChangelog = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to compile changelogs");
  }

  const { projectId } = request.data;
  if (!projectId) {
    throw new HttpsError("invalid-argument", "Missing projectId");
  }

  const db = getFirestore();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    throw new HttpsError("not-found", "Project not found");
  }

  if (projectSnap.data()?.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only project owner can compile changelogs");
  }

  // Fetch all draft changelogs
  const changelogsRef = projectRef.collection("changelogs");
  const draftsSnap = await changelogsRef.where("status", "==", "draft").get();

  if (draftsSnap.empty) {
    return { success: false, message: "No drafts found to compile" };
  }

  // Aggregate raw commits
  const rawCommits = draftsSnap.docs
    .map(doc => doc.data().rawCommit || doc.data().rawCommits || "")
    .filter(commit => commit.trim().length > 0)
    .join("\n- ");

  if (!rawCommits) {
    return { success: false, message: "Drafts contain no raw commit data" };
  }

  let aiTechnicalSummary = "Code update pushed.";
  let aiNonTechnicalSummary = "A new update was pushed to the repository.";
  let themeCategory = "Feature";

  try {
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert product marketer and lead engineer. 
      Analyze the following aggregated developer commit messages from a single day of work.
      
      Respond STRICTLY with a valid JSON object matching this exact schema:
      {
        "technicalSummary": "A detailed, professional, developer-focused summary of the architecture or code changes (2-4 sentences). Avoid generic phrases.",
        "nonTechnicalSummary": "A high-level, business-value summary for non-technical users, recruiters or investors that avoids technical jargon (2-3 sentences). Focus on what value was created.",
        "themeCategory": "Must be EXACTLY one of: Feature, Fix, Polish, Infra, Security"
      }

      Aggregated Commits:
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
    throw new HttpsError("internal", "Failed to generate AI summary");
  }

  // Create new compiled draft
  await changelogsRef.add({
    status: "draft",
    technicalSummary: aiTechnicalSummary,
    nonTechnicalSummary: aiNonTechnicalSummary,
    themeCategory: themeCategory,
    rawCommit: rawCommits,
    createdAt: new Date(),
    ownerId: request.auth.uid,
    isCompiled: true
  });

  // Delete old individual drafts
  const batch = db.batch();
  draftsSnap.docs.forEach(doc => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  return { success: true, message: "Successfully compiled drafts" };
});
