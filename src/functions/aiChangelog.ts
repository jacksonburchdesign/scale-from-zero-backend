import { onCall, HttpsError } from "firebase-functions/v2/https";
import { VertexAI } from "@google-cloud/vertexai";

export const formatChangelogWithAI = onCall(async (request) => {
  // Ensure the user is authenticated
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "User must be authenticated to use the AI features."
    );
  }

  const { rawText } = request.data;
  if (!rawText) {
    throw new HttpsError("invalid-argument", "Missing raw text payload.");
  }

  try {
    // VertexAI config (project details to be injected via environment or config)
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
      ${rawText}
    `;

    const result = await generativeModel.generateContent(prompt);
    const response = await result.response;
    const aiText = response.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";

    return { formattedText: aiText };
  } catch (error) {
    console.error("AI Generation Error:", error);
    throw new HttpsError("internal", "Failed to generate AI changelog format.");
  }
});
