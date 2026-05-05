import { onCall, HttpsError } from "firebase-functions/v2/https";


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
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-2.5-pro",
    });

    const prompt = `
      You are an expert product marketer communicating to investors and non-technical stakeholders.
      Rewrite the following rough developer changelog into a polished, positive, high-conversion summary.
      Format the output STRICTLY in Markdown. Start with a single catchy headline featuring an appropriate emoji.
      Follow this with 1 to 3 concise bullet points highlighting the business impact, traction, and value created.
      Bold the most important keywords to draw the eye.
      
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
