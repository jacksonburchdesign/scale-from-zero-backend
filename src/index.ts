import * as admin from "firebase-admin";
import { formatChangelogWithAI } from "./functions/aiChangelog.js";
import { githubWebhook } from "./functions/githubWebhook.js";
import { vercelWebhook } from "./functions/vercelWebhook.js";
import { generateInvite } from "./functions/generateInvite.js";
import { acceptInvite } from "./functions/acceptInvite.js";

admin.initializeApp();

export { formatChangelogWithAI, githubWebhook, vercelWebhook, generateInvite, acceptInvite };
