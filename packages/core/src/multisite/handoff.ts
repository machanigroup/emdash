import { generateTokenWithHash, hashToken } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { ControlPlaneDatabase } from "./types.js";

/** How long a sign-in handoff token stays valid. */
export const HANDOFF_TTL_MS = 60_000;

/**
 * Issues a single-use token that signs `userId` in on one site's hostname.
 * The admin host issues it for a user it has already signed in; the site
 * redeems it with {@link consumeHandoff} and starts its own session. Only the
 * token's hash is stored.
 */
export async function createHandoff(
	controlPlane: Kysely<ControlPlaneDatabase>,
	input: { userId: string; siteId: string; now?: number },
): Promise<string> {
	const now = input.now ?? Date.now();
	await controlPlane
		.deleteFrom("_emdash_site_handoffs")
		.where("expires_at", "<", new Date(now).toISOString())
		.execute();
	const { token, hash } = generateTokenWithHash();
	await controlPlane
		.insertInto("_emdash_site_handoffs")
		.values({
			token_hash: hash,
			user_id: input.userId,
			site_id: input.siteId,
			expires_at: new Date(now + HANDOFF_TTL_MS).toISOString(),
		})
		.execute();
	return token;
}

/**
 * Redeems a handoff token for the site it was issued for. Returns the user id,
 * or null when the token is unknown, already used, expired, or issued for
 * another site. The token is deleted in the same statement that reads it, so
 * two requests can't both redeem it.
 */
export async function consumeHandoff(
	controlPlane: Kysely<ControlPlaneDatabase>,
	token: string,
	siteId: string,
	now = Date.now(),
): Promise<string | null> {
	const row = await controlPlane
		.deleteFrom("_emdash_site_handoffs")
		.where("token_hash", "=", hashToken(token))
		.returning(["user_id", "site_id", "expires_at"])
		.executeTakeFirst();
	if (!row || row.site_id !== siteId) return null;
	if (row.expires_at < new Date(now).toISOString()) return null;
	return row.user_id;
}

/** A same-site path to return to after sign-in, or `/` when `value` isn't one. */
export function safeReturnPath(value: string | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
		return "/";
	}
	return value;
}
