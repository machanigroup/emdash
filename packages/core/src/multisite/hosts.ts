import type { Kysely } from "kysely";

import { MultiSiteError } from "./errors.js";
import type { ControlPlaneDatabase } from "./types.js";

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const IPV4_PATTERN = /^[0-9.]+$/;
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Reduce a `Host` header value or URL hostname to the form stored in
 * `_emdash_site_hosts`: lower case, no port, no trailing dot. Returns null for
 * values that cannot name a registered site, including IP literals.
 */
export function normalizeHostname(host: string | null | undefined): string | null {
	if (!host) return null;
	let value = host.trim().toLowerCase();
	if (value.startsWith("[")) return null;
	const colon = value.indexOf(":");
	if (colon !== -1) value = value.slice(0, colon);
	if (value.endsWith(".")) value = value.slice(0, -1);
	if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH) return null;
	if (!HOSTNAME_PATTERN.test(value)) return null;
	if (IPV4_PATTERN.test(value)) return null;
	return value;
}

export function requireHostname(host: string): string {
	const normalized = normalizeHostname(host);
	if (!normalized) {
		throw new MultiSiteError("INVALID_HOSTNAME", `Invalid hostname: ${host}`);
	}
	return normalized;
}

export interface ResolvedSiteHost {
	siteId: string;
	orgId: string;
	databaseRef: string;
	storageRef: string | null;
}

/**
 * Maps request hostnames to active sites. The whole table is read in one query
 * and held until `invalidate()`, so resolving a host costs no query after the
 * first call. Disabled sites are left out of the map and resolve to null.
 */
export class SiteHostResolver {
	#hosts: Promise<Map<string, ResolvedSiteHost>> | null = null;

	constructor(private readonly db: Kysely<ControlPlaneDatabase>) {}

	async resolve(host: string | null | undefined): Promise<ResolvedSiteHost | null> {
		const hostname = normalizeHostname(host);
		if (!hostname) return null;
		const hosts = await this.#load();
		return hosts.get(hostname) ?? null;
	}

	invalidate(): void {
		this.#hosts = null;
	}

	#load(): Promise<Map<string, ResolvedSiteHost>> {
		if (!this.#hosts) {
			const pending = this.#read();
			this.#hosts = pending;
			pending.catch(() => {
				if (this.#hosts === pending) this.#hosts = null;
			});
		}
		return this.#hosts;
	}

	async #read(): Promise<Map<string, ResolvedSiteHost>> {
		const rows = await this.db
			.selectFrom("_emdash_site_hosts as h")
			.innerJoin("_emdash_sites as s", "s.id", "h.site_id")
			.select(["h.hostname", "s.id", "s.org_id", "s.database_ref", "s.storage_ref"])
			.where("s.status", "=", "active")
			.execute();
		return new Map(
			rows.map((row) => [
				row.hostname,
				{
					siteId: row.id,
					orgId: row.org_id,
					databaseRef: row.database_ref,
					storageRef: row.storage_ref,
				},
			]),
		);
	}
}
