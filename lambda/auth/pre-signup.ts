import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { acceptedCodes } from '../shared/invite-code';

/**
 * Cognito cannot express two of this club's rules, so both live here. This is
 * the only place they can be enforced — a client-side check is decoration,
 * since anyone can call the SignUp API directly.
 *
 *   1. Email and phone are each optional, but at least one is required.
 *   2. Sign-up requires the club's invite code, which changes every day.
 */

const secrets = new SecretsManagerClient({});

// Cached for the life of the container. The secret rotates approximately
// never, and re-reading it on every sign-up would add latency for nothing.
let cachedSecret: string | undefined;

async function inviteSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.INVITE_SECRET_ARN! })
  );
  cachedSecret = res.SecretString!;
  return cachedSecret;
}

export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  const attrs = event.request.userAttributes ?? {};
  const email = attrs.email?.trim();
  const phone = attrs.phone_number?.trim();

  if (!email && !phone) {
    throw new Error('Sign up with an email address or a phone number.');
  }

  // The permanent rule is "at least one contact". But until SMS can actually
  // deliver, a phone-only account could never receive a code and so could
  // never sign in — better to say so at sign-up than to hand someone a dead
  // account. Phase 5 flips SMS_ENABLED and this branch stops applying.
  if (!email && process.env.SMS_ENABLED !== 'true') {
    throw new Error('Text messages are not available yet — please sign up with an email address.');
  }

  // The code travels in ClientMetadata rather than as a user attribute, so it
  // is never stored on the account.
  const submitted = (event.request.clientMetadata?.inviteCode ?? '')
    .trim()
    .toUpperCase();

  if (!submitted) {
    throw new Error("Enter the club's invite code to sign up.");
  }

  const valid = acceptedCodes(await inviteSecret());
  if (!valid.includes(submitted)) {
    // Deliberately vague: do not reveal whether the code was merely stale.
    throw new Error("That invite code isn't valid. Ask at the club for today's code.");
  }

  console.log('pre-signup accepted', {
    hasEmail: !!email,
    hasPhone: !!phone,
    // Never log the code itself or the contact details.
  });

  // Leave autoConfirmUser false — the whole point is that they prove they
  // control the address by entering the code Cognito sends them.
  return event;
}
