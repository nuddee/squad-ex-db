/** Minimum password length for admin-created users and the bootstrap admin (enforced server-side). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function validatePassword(pw: unknown): { ok: boolean; message?: string } {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return { ok: true };
}
