import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import * as crypto from "crypto";

export const generateInvite = onCall(async (request) => {
  const { projectId } = request.data;

  // 1. Check Authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated to generate invites.");
  }

  if (!projectId) {
    throw new HttpsError("invalid-argument", "Project ID is required.");
  }

  const db = getFirestore();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    throw new HttpsError("not-found", "Project not found.");
  }

  const projectData = projectSnap.data();

  // 2. Check Authorization (Only 'owner' can invite)
  // Support both legacy ownerId and new members map
  const isOwner = projectData?.ownerId === request.auth.uid || projectData?.members?.[request.auth.uid] === "owner";
  
  if (!isOwner) {
    throw new HttpsError("permission-denied", "Only project owners can generate invites.");
  }

  // 3. Generate Token
  const token = crypto.randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // Expires in 7 days

  // 4. Save Invite
  await db.collection("invites").doc(token).set({
    projectId,
    role: "contributor",
    createdBy: request.auth.uid,
    createdAt: new Date(),
    expiresAt,
    used: false
  });

  return { token };
});
