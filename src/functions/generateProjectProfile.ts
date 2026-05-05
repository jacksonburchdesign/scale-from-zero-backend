import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

import * as logger from "firebase-functions/logger";

export const generateProjectProfile = onCall({ timeoutSeconds: 60, memory: '512MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to generate profile.");
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

  const data = projectSnap.data();
  if (data?.ownerId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only project owner can generate profile.");
  }

  const repoFullName = data?.githubRepoFullName;
  if (!repoFullName) {
    throw new HttpsError("failed-precondition", "Project does not have a GitHub repository connected.");
  }

  // Helper to fetch from GitHub raw content
  const fetchGitHubRaw = async (path: string) => {
    try {
      let res = await fetch(`https://raw.githubusercontent.com/${repoFullName}/main/${path}`);
      if (!res.ok) {
        res = await fetch(`https://raw.githubusercontent.com/${repoFullName}/master/${path}`);
      }
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      return null;
    }
  };

  const packageJson = await fetchGitHubRaw('package.json');
  const readme = await fetchGitHubRaw('README.md');

  if (!packageJson && !readme) {
    throw new HttpsError("not-found", "Could not fetch README.md or package.json from the public repository. Make sure the repo is public and uses main/master branches.");
  }

  try {
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT || "scale-from-zero", location: "us-central1" });
    const generativeModel = vertexAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
      You are an expert lead engineer and product marketer.
      Analyze the following files from a GitHub repository to generate a complete project profile.
      
      Respond STRICTLY with a valid JSON object matching this exact schema:
      {
        "technicalSummary": "A detailed, professional, developer-focused summary of the architecture, stack, and implementation details (2-3 paragraphs).",
        "techStack": "A comma-separated list of the technologies used (e.g., 'React, Node.js, Firebase, Tailwind CSS'). Extract this from package.json and the README.",
        "skillsUtilized": "A comma-separated list of skills and estimated percentages (e.g., 'React:80, TypeScript:60, Node.js:40'). Total does not need to equal 100, just rough proportions.",
        "executiveSummary": "A high-level summary of the product vision and goals (1-2 paragraphs).",
        "problemStatement": "What problem does this project solve? (1 paragraph)",
        "solutionStatement": "How does the project solve it? (1 paragraph)"
      }

      package.json:
      ${packageJson ? packageJson.substring(0, 5000) : "Not found"}

      README.md:
      ${readme ? readme.substring(0, 10000) : "Not found"}
    `;

    const result = await generativeModel.generateContent(prompt);
    const response = await result.response;
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      logger.error("Failed to parse JSON from Vertex AI", e, text);
      throw new HttpsError("internal", "Failed to parse AI output.");
    }

    // Update Firestore
    await projectRef.update({
      technicalSummary: parsed.technicalSummary || data.technicalSummary || "",
      techStack: parsed.techStack || data.techStack || "",
      skillsUtilized: parsed.skillsUtilized || data.skillsUtilized || "",
      executiveSummary: parsed.executiveSummary || data.executiveSummary || "",
      problemStatement: parsed.problemStatement || data.problemStatement || "",
      solutionStatement: parsed.solutionStatement || data.solutionStatement || ""
    });

    return { success: true, message: "Successfully generated project profile." };
  } catch (error) {
    logger.error("Vertex AI Error:", error);
    throw new HttpsError("internal", "Failed to generate AI profile.");
  }
});
