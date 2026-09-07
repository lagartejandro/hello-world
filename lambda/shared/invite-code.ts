import { createHmac } from 'crypto';

/**
 * The club's daily sign-up code.
 *
 * Derived rather than stored: it is a pure function of a secret seed and the
 * current date, so it rotates itself at midnight with no table, no cron and no
 * admin screen. The PreSignUp trigger validates it; the ladder API shows the
 * operator what today's is.
 */

// Deliberately excludes I, L, O, U, 0 and 1 — the code gets read aloud in a
// loud bar and written on a card, so characters that look or sound alike are
// a support problem rather than a security one.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * The date in the club's timezone, not UTC. UTC midnight is 8pm in New York,
 * which would rotate the code in the middle of a chess night.
 */
export function clubDate(now = new Date(), timeZone = process.env.CLUB_TZ ?? 'America/New_York'): string {
  // en-CA formats as YYYY-MM-DD, which is what we want to hash.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function codeForDate(secret: string, date: string): string {
  const digest = createHmac('sha256', secret).update(date).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

/** Today's code, plus yesterday's. */
export function acceptedCodes(secret: string, now = new Date()): string[] {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Someone screenshots the code at 11pm and signs up at 12:05am. Rejecting
  // them is technically correct and practically useless.
  return [codeForDate(secret, clubDate(now)), codeForDate(secret, clubDate(yesterday))];
}
