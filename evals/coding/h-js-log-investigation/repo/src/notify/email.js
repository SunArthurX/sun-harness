export function normalizeEmail(email) {
  // Lowercase and trim user-entered addresses.
  return email.toLowerCase().trim();
}
