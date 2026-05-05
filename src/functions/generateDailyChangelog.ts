import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

export const generateDailyChangelog = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to generate changelog.");
  }

  const { projectId, changelogIds } = request.data;
  if (!projectId || !changelogIds || !Array.isArray(changelogIds) || changelogIds.length === 0) {
    throw new HttpsError("invalid-argument", "Missing projectId or changelogIds.");
  }

  const db = getFirestore();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    throw new HttpsError("not-found", "Project not found");
  }

  if (projectSnap.data()?.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only project owner can generate changelog.");
  }

  const changelogsRef = projectRef.collection("changelogs");
  const rawCommits: string[] = [];
  const validIds: string[] = [];

  // Fetch all requested raw-commits
  for (const id of changelogIds) {
    const docSnap = await changelogsRef.doc(id).get();
    if (docSnap.exists) {
      const data = docSnap.data();
      if (data?.status === "raw-commit" && data.rawCommit) {
        rawCommits.push(`[${data.sourceRepo || 'repo'}]: ${data.rawCommit}`);
        validIds.push(id);
      }
    }
  }

  if (rawCommits.length === 0) {
    throw new HttpsError("failed-precondition", "No valid raw-commit records found to summarize.");
  }

  const combinedRawCommits = rawCommits.join("\n");

  let aiTechnicalSummary = "Multiple updates pushed.";
  let aiNonTechnicalSummary = "A series of updates were applied to the project.";
  let themeCategory = "Feature";
  let isTrivial = false;

  try {
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert product marketer and lead engineer analyzing a day's worth of commit messages across repositories.
      Determine if the combined push contains meaningful updates or just trivial changes (like "typo fix", "merge main", "bump dependencies").
      If the commits are entirely trivial, set "isTrivial" to true.
      Otherwise, synthesize the meaningful commits into a single cohesive changelog entry.
      
      Respond STRICTLY with a valid JSON object matching this exact schema:
      {
        "isTrivial": boolean,
        "technicalSummary": "A detailed, professional, developer-focused summary of the architecture or code changes across all commits (3-5 sentences). Avoid generic phrases.",
        "nonTechnicalSummary": "A high-level, business-value summary for non-technical users that avoids technical jargon (2-3 sentences). Focus on what value was created today.",
        "themeCategory": "Must be EXACTLY one of: Feature, Fix, Polish, Infra, Security"
      }

      Raw Commits:
      ${combinedRawCommits}
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
    throw new HttpsError("internal", "Failed to generate AI summary.");
  }

  // Use a batch to perform the atomic swap
  const batch = db.batch();

  if (isTrivial) {
    // If trivial, just delete the raw-commits and don't create a draft
    for (const id of validIds) {
      batch.delete(changelogsRef.doc(id));
    }
    await batch.commit();
    return { success: true, message: "Commits were trivial and discarded." };
  }

  // Create the new summarized draft changelog
  const draftRef = changelogsRef.doc();
  batch.set(draftRef, {
    status: "draft",
    technicalSummary: aiTechnicalSummary,
    nonTechnicalSummary: aiNonTechnicalSummary,
    themeCategory: themeCategory,
    rawCommit: combinedRawCommits, // Keep the combined raw commits for reference
    createdAt: new Date(),
    ownerId: request.auth.uid,
  });

  // Delete the old raw-commits
  for (const id of validIds) {
    batch.delete(changelogsRef.doc(id));
  }

  await batch.commit();

  return { success: true, draftId: draftRef.id, message: "Successfully generated daily changelog draft." };
});
