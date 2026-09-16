import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { audit } from "./audit.ts";
import {
  type Credential,
  addCredential,
  findCredentialForVerification,
  listCredentials,
  recordCredentialUse,
} from "./credentials.ts";
import { db } from "./db.server.ts";
import {
  consumeRegistration,
  findUsableRegistration,
  getRegistration,
  revokeUnusedBootstrapLinks,
} from "./registrations.ts";
import { createSession } from "./sessions.ts";
import { describeUserAgent } from "./user-agent.ts";
import {
  type User,
  UserInputError,
  countActiveAdmins,
  createUser,
  getUser,
  newWebauthnUserId,
  normalizeName,
} from "./users.ts";
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
  putCeremony,
  rpParams,
  takeCeremony,
} from "./webauthn.ts";

/**
 * The passkey flows end to end, minus HTTP. Routes stay thin: they read
 * cookies and bodies, call these, and set cookies from what comes back.
 */

const LINK_UNUSABLE =
  "This link has expired or has already been used. Ask an admin for a new one.";
const CEREMONY_LOST = "That took too long, or was started elsewhere. Please try again.";

// ---- enrollment (registering a passkey) ------------------------------------------

export async function startEnrollment(args: {
  /** Token from a one-time link, if the person arrived through one. */
  joinToken: string | null;
  /** The signed-in person, if any (adding a passkey to their own account). */
  currentUser: User | null;
  /** Display name, required when the link creates a new person. */
  name: unknown;
}): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  if (args.joinToken) {
    const reg = findUsableRegistration(args.joinToken);
    if (!reg) throw new UserInputError(LINK_UNUSABLE);

    if (reg.purpose === "add_device") {
      const user = reg.userId == null ? null : getUser(reg.userId);
      if (!user?.active) throw new UserInputError(LINK_UNUSABLE);
      const options = await beginRegistration({
        webauthnUserId: user.webauthnUserId,
        userName: user.name,
        existing: listCredentials(user.id),
      });
      const ceremonyId = putCeremony({
        kind: "register",
        challenge: options.challenge,
        registrationId: reg.id,
        userId: user.id,
        newUser: null,
      });
      return { ceremonyId, options };
    }

    const newUser = {
      name: normalizeName(args.name),
      role: reg.role,
      webauthnUserId: newWebauthnUserId(),
    };
    const options = await beginRegistration({
      webauthnUserId: newUser.webauthnUserId,
      userName: newUser.name,
      existing: [],
    });
    const ceremonyId = putCeremony({
      kind: "register",
      challenge: options.challenge,
      registrationId: reg.id,
      userId: null,
      newUser,
    });
    return { ceremonyId, options };
  }

  if (args.currentUser) {
    const user = args.currentUser;
    const options = await beginRegistration({
      webauthnUserId: user.webauthnUserId,
      userName: user.name,
      existing: listCredentials(user.id),
    });
    const ceremonyId = putCeremony({
      kind: "register",
      challenge: options.challenge,
      registrationId: null,
      userId: user.id,
      newUser: null,
    });
    return { ceremonyId, options };
  }

  throw new UserInputError("Sign in first, or open the link an admin sent you.");
}

export interface EnrollmentResult {
  user: User;
  credential: Credential;
  /** A session token, when the enrollment signed the person in. */
  sessionToken: string | null;
}

export async function finishEnrollment(args: {
  ceremonyId: string | null;
  response: RegistrationResponseJSON;
  userAgent: string | null;
  now?: number;
}): Promise<EnrollmentResult> {
  const ceremony = takeCeremony(args.ceremonyId);
  if (!ceremony || ceremony.kind !== "register") throw new UserInputError(CEREMONY_LOST);

  const verified = await finishRegistration({
    challenge: ceremony.challenge,
    response: args.response,
  });
  if (!verified) throw new UserInputError("That passkey couldn't be verified. Please try again.");

  const now = args.now ?? Date.now();
  const database = db();
  try {
    return database.transaction((): EnrollmentResult => {
      const registration =
        ceremony.registrationId != null ? getRegistration(ceremony.registrationId) : null;
      // Re-checked here, inside the transaction, rather than trusted from when
      // the ceremony started: two setup links completed at once must not both
      // produce an admin.
      if (registration?.purpose === "bootstrap" && countActiveAdmins() > 0) {
        throw new UserInputError(LINK_UNUSABLE);
      }

      let user: User;
      if (ceremony.newUser) {
        user = createUser({
          name: ceremony.newUser.name,
          role: ceremony.newUser.role,
          webauthnUserId: ceremony.newUser.webauthnUserId,
          actorUserId: null,
          now,
        });
      } else {
        const existing = ceremony.userId == null ? null : getUser(ceremony.userId);
        if (!existing?.active) throw new UserInputError(LINK_UNUSABLE);
        user = existing;
      }

      // Consume inside the same transaction as the writes it authorises: if
      // the link was used in another tab a moment ago, everything above rolls
      // back, including the person just created.
      if (ceremony.registrationId != null) {
        if (!consumeRegistration({ id: ceremony.registrationId, userId: user.id, now })) {
          throw new UserInputError(LINK_UNUSABLE);
        }
        // Setup is done; no other setup link may linger.
        if (registration?.purpose === "bootstrap") revokeUnusedBootstrapLinks(now);
      }

      // Registering through a link also signs the person in, so the passkey
      // has genuinely been used.
      const signsIn = ceremony.registrationId != null;

      const credential = addCredential({
        userId: user.id,
        credentialId: verified.credential.id,
        publicKey: verified.credential.publicKey,
        counter: verified.credential.counter,
        transports: verified.credential.transports,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        nickname: describeUserAgent(args.userAgent),
        lastUsedAt: signsIn ? now : null,
        now,
      });

      // Arriving through a link signs you in. Adding a passkey while already
      // signed in keeps the session you have.
      const sessionToken = signsIn
        ? createSession({ userId: user.id, credentialId: credential.id, userAgent: args.userAgent, now }).token
        : null;

      return { user, credential, sessionToken };
    })();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: credentials\.credential_id/.test(err.message)) {
      throw new UserInputError("That passkey is already registered.");
    }
    throw err;
  }
}

// ---- sign-in -------------------------------------------------------------------------

export async function startSignIn(): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const options = await beginAuthentication();
  const ceremonyId = putCeremony({ kind: "authenticate", challenge: options.challenge });
  return { ceremonyId, options };
}

export type SignInResult =
  | { ok: true; user: User; sessionToken: string }
  | {
      ok: false;
      message: string;
      /**
       * Set when the passkey isn't one we know (typically removed on the
       * server). The client passes it to the WebAuthn Signal API so the
       * person's passkey manager stops offering it.
       */
      unknownCredential?: { rpID: string; credentialID: string };
    };

export async function finishSignIn(args: {
  ceremonyId: string | null;
  response: AuthenticationResponseJSON;
  userAgent: string | null;
  now?: number;
}): Promise<SignInResult> {
  const ceremony = takeCeremony(args.ceremonyId);
  if (!ceremony || ceremony.kind !== "authenticate") {
    return { ok: false, message: CEREMONY_LOST };
  }

  const stored = findCredentialForVerification(args.response.id);
  if (!stored) {
    return {
      ok: false,
      message: "That passkey isn't registered here any more. Choose another, or ask an admin for a device link.",
      unknownCredential: { rpID: rpParams().rpID, credentialID: args.response.id },
    };
  }

  const verified = await finishAuthentication({
    challenge: ceremony.challenge,
    response: args.response,
    credential: {
      id: stored.credentialId,
      publicKey: stored.publicKey,
      counter: stored.counter,
      transports: stored.transports as never,
    },
  });
  if (!verified) return { ok: false, message: "Sign-in couldn't be verified. Please try again." };

  const user = getUser(stored.userId);
  if (!user?.active) {
    audit({
      actorUserId: stored.userId,
      entity: "user",
      entityId: stored.userId,
      action: "signin_refused_inactive",
    });
    return { ok: false, message: "This account has been deactivated. Talk to an admin." };
  }

  const now = args.now ?? Date.now();
  recordCredentialUse({ id: stored.id, counter: verified.newCounter, now });
  const { token } = createSession({
    userId: user.id,
    credentialId: stored.id,
    userAgent: args.userAgent,
    now,
  });
  return { ok: true, user, sessionToken: token };
}
