import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

export const regenerateChangelog = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to regenerate changelog.");
  }

  const { projectId, changelogId } = request.data;
  if (!projectId || !changelogId) {
    throw new HttpsError("invalid-argument", "Missing projectId or changelogId.");
  }

  const db = getFirestore();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    throw new HttpsError("not-found", "Project not found");
  }

  if (projectSnap.data()?.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only project owner can regenerate changelog.");
  }

  const changelogRef = projectRef.collection("changelogs").doc(changelogId);
  const changelogSnap = await changelogRef.get();

  if (!changelogSnap.exists) {
    throw new HttpsError("not-found", "Changelog not found");
  }

  const data = changelogSnap.data();
  const rawCommits = data?.rawCommit || data?.rawCommits || "";

  if (!rawCommits || rawCommits.trim().length === 0) {
    throw new HttpsError("failed-precondition", "Changelog contains no raw commit data to regenerate.");
  }

  let aiTechnicalSummary = data?.technicalSummary || "Code update pushed.";
  let aiNonTechnicalSummary = data?.nonTechnicalSummary || "A new update was pushed to the repository.";
  let themeCategory = data?.themeCategory || "Feature";

  try {
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert product marketer and lead engineer. 
      Analyze the following aggregated developer commit messages from a single day of work.
      
      Respond STRICTLY with a valid JSON object matching this exact schema:
      {
        "technicalSummary": "A detailed, professional, developer-focused summary of the architecture or code changes (2-4 sentences). Avoid generic phrases.",
        "nonTechnicalSummary": "A high-level, highly scannable business-value summary for investors, marketers, and recruiters. Format the output STRICTLY in Markdown. Start with a single catchy headline featuring an appropriate emoji. Follow this with 1 to 3 concise bullet points highlighting the business impact, traction, and value created. Bold the most important keywords.",
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

  // Update the existing draft or published changelog
  await changelogRef.update({
    technicalSummary: aiTechnicalSummary,
    nonTechnicalSummary: aiNonTechnicalSummary,
    themeCategory: themeCategory,
    updatedAt: new Date(),
  });

  return { success: true, message: "Successfully regenerated changelog." };
});
