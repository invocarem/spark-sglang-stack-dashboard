/**
 * Load repo-root `.env` into `process.env` before the rest of the server.
 * Keeps MONITOR_* and optional cluster defaults out of the shell when using `npm run dev`.
 */

import dotenv from "dotenv";
import path from "node:path";
import { findRepoRoot } from "./repo-root.js";

const envPath = path.join(findRepoRoot(), ".env");
dotenv.config({ path: envPath });
