import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

export const acceptInvite = onCall(async (request) => {
  const { token } = request.data;

  // 1. Check Authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated to accept invites.");
  }

  if (!token) {
    throw new HttpsError("invalid-argument", "Invite token is required.");
  }

  const db = getFirestore();
  const inviteRef = db.collection("invites").doc(token);
  
  // Use a transaction to ensure invite is only used once
  const result = await db.runTransaction(async (t) => {
    const inviteSnap = await t.get(inviteRef);

    if (!inviteSnap.exists) {
      throw new HttpsError("not-found", "Invalid or expired invite link.");
    }

    const inviteData = inviteSnap.data()!;

    if (inviteData.used) {
      throw new HttpsError("already-exists", "This invite link has already been used.");
    }

    if (inviteData.expiresAt.toDate() < new Date()) {
      throw new HttpsError("failed-precondition", "This invite link has expired.");
    }

    const projectId = inviteData.projectId;
    const projectRef = db.collection("projects").doc(projectId);
    const projectSnap = await t.get(projectRef);

    if (!projectSnap.exists) {
      throw new HttpsError("not-found", "The project associated with this invite no longer exists.");
    }

    // Update Project Members Map
    // We use set with merge: true to just update the specific member field in the map
    const uid = request.auth!.uid;
    t.set(projectRef, {
      members: {
        [uid]: inviteData.role
      }
    }, { merge: true });

    // Mark Invite as Used
    t.update(inviteRef, {
      used: true,
      usedBy: uid,
      usedAt: new Date()
    });

    return { projectId, projectName: projectSnap.data()?.projectName };
  });

  return result;
});
