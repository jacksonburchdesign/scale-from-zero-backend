import { initializeApp } from "firebase-admin/app";
import { formatChangelogWithAI } from "./functions/aiChangelog.js";
// githubWebhook removed in favor of githubAppWebhook
import { vercelWebhook } from "./functions/vercelWebhook.js";
import { generateInvite } from "./functions/generateInvite.js";
import { acceptInvite } from "./functions/acceptInvite.js";

initializeApp();

import { compileDailyChangelog } from "./functions/compileDailyChangelog.js";
import { generateProjectProfile } from "./functions/generateProjectProfile.js";
import { githubAppWebhook } from "./functions/githubAppWebhook.js";
import { generateDailyChangelog } from "./functions/generateDailyChangelog.js";

export { formatChangelogWithAI, githubAppWebhook, vercelWebhook, generateInvite, acceptInvite, compileDailyChangelog, generateProjectProfile, generateDailyChangelog };
