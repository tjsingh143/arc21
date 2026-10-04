/**
 * Pin the local Data API independently of the CLI. PostgREST 16.1's stale
 * cached clock intermittently refuses freshly issued real Auth JWTs; 16.3 fixes
 * it upstream. Supabase CLI 2.115/2.116 read this ignored service-version file.
 * No hosted project is contacted or changed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve(import.meta.dirname, "../supabase/.temp");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "rest-version"), "v16.3");
console.log("Local PostgREST pinned to v16.3 (fresh-JWT clock fix).");
