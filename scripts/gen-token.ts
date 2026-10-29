/**
 * Print a cryptographically random 48-character token for ADMIN_IMPORT_TOKEN.
 *
 *   pnpm gen-token
 */
import { generateAdminToken } from "../lib/env";

console.log(generateAdminToken(48));
