import { initializeApp } from "firebase-admin/app";
import { formatChangelogWithAI } from "./functions/aiChangelog.js";
import { githubWebhook } from "./functions/githubWebhook.js";
import { vercelWebhook } from "./functions/vercelWebhook.js";
import { generateInvite } from "./functions/generateInvite.js";
import { acceptInvite } from "./functions/acceptInvite.js";

initializeApp();

import { compileDailyChangelog } from "./functions/compileDailyChangelog.js";
import { generateProjectProfile } from "./functions/generateProjectProfile.js";

export { formatChangelogWithAI, githubWebhook, vercelWebhook, generateInvite, acceptInvite, compileDailyChangelog, generateProjectProfile };
