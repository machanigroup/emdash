import type { Kysely } from "kysely";

import { after } from "../after.js";
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
	name: string;
	/** The hostname links to the site use. */
	primaryHostname: string;
	databaseRef: string;
	storageRef: string | null;
}

/**
 * Maps request hostnames to active sites. The whole table is read in one query
 * and served from memory. Once the table is older than `refreshAfterMs`, the
 * next lookup still answers from memory and reloads the table in the
 * background, so hostname changes made by another worker show up without
 * adding a query to any request. Disabled sites are left out of the map and
 * resolve to null.
 */
export class SiteHostResolver {
	#hosts: Promise<Map<string, ResolvedSiteHost>> | null = null;
	#loadedAt = 0;
	#refreshing = false;
	readonly #refreshAfterMs: number;

	constructor(
		private readonly db: Kysely<ControlPlaneDatabase>,
		options: { refreshAfterMs?: number } = {},
	) {
		this.#refreshAfterMs = options.refreshAfterMs ?? Number.POSITIVE_INFINITY;
	}

	async resolve(host: string | null | undefined): Promise<ResolvedSiteHost | null> {
		const hostname = normalizeHostname(host);
		if (!hostname) return null;
		const hosts = await this.#load();
		if (Date.now() - this.#loadedAt > this.#refreshAfterMs) this.#refreshInBackground();
		return hosts.get(hostname) ?? null;
	}

	/** An active site by id, from the same cached table. */
	async findSite(siteId: string): Promise<ResolvedSiteHost | null> {
		const hosts = await this.#load();
		for (const host of hosts.values()) {
			if (host.siteId === siteId) return host;
		}
		return null;
	}

	/** Every active site, one entry each, from the same cached table. */
	async allSites(): Promise<ResolvedSiteHost[]> {
		const hosts = await this.#load();
		const sites = new Map<string, ResolvedSiteHost>();
		for (const host of hosts.values()) sites.set(host.siteId, host);
		return [...sites.values()];
	}

	/** Discards the table so the next lookup reloads it. Call after changing sites or hostnames. */
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

	#refreshInBackground(): void {
		if (this.#refreshing) return;
		this.#refreshing = true;
		const current = this.#hosts;
		after(async () => {
			try {
				const fresh = await this.#read();
				if (this.#hosts === current) this.#hosts = Promise.resolve(fresh);
			} catch (error) {
				console.error("[emdash:multisite] refreshing site hostnames failed:", error);
			} finally {
				this.#refreshing = false;
			}
		});
	}

	async #read(): Promise<Map<string, ResolvedSiteHost>> {
		const rows = await this.db
			.selectFrom("_emdash_site_hosts as h")
			.innerJoin("_emdash_sites as s", "s.id", "h.site_id")
			.select([
				"h.hostname",
				"h.is_primary",
				"s.id",
				"s.org_id",
				"s.name",
				"s.database_ref",
				"s.storage_ref",
			])
			.where("s.status", "=", "active")
			.execute();
		this.#loadedAt = Date.now();
		const primary = new Map<string, string>();
		for (const row of rows) {
			if (row.is_primary === 1 || !primary.has(row.id)) primary.set(row.id, row.hostname);
		}
		return new Map(
			rows.map((row) => [
				row.hostname,
				{
					siteId: row.id,
					orgId: row.org_id,
					name: row.name,
					primaryHostname: primary.get(row.id) ?? row.hostname,
					databaseRef: row.database_ref,
					storageRef: row.storage_ref,
				},
			]),
		);
	}
}
