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
	/** The hostname links to the site use, or null while the site has none. */
	primaryHostname: string | null;
	databaseRef: string;
	storageRef: string | null;
}

/** Active sites by id, and by each hostname they answer on. */
interface SiteTable {
	hosts: Map<string, ResolvedSiteHost>;
	sites: Map<string, ResolvedSiteHost>;
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
	#table: SiteTable | null = null;
	#loadedAt = 0;
	#refreshing = false;
	readonly #refreshAfterMs: number;
	readonly #db: () => Kysely<ControlPlaneDatabase>;

	/**
	 * `db` is called for every read, so a request-scoped connection can be
	 * supplied per request. Only the loaded table is shared between requests,
	 * never a connection or a pending read.
	 */
	constructor(
		db: Kysely<ControlPlaneDatabase> | (() => Kysely<ControlPlaneDatabase>),
		options: { refreshAfterMs?: number } = {},
	) {
		this.#db = typeof db === "function" ? db : () => db;
		this.#refreshAfterMs = options.refreshAfterMs ?? Number.POSITIVE_INFINITY;
	}

	async resolve(host: string | null | undefined): Promise<ResolvedSiteHost | null> {
		const hostname = normalizeHostname(host);
		if (!hostname) return null;
		const { hosts } = await this.#load();
		if (Date.now() - this.#loadedAt > this.#refreshAfterMs) this.#refreshInBackground();
		return hosts.get(hostname) ?? null;
	}

	/** An active site by id, from the same cached table. */
	async findSite(siteId: string): Promise<ResolvedSiteHost | null> {
		const { sites } = await this.#load();
		return sites.get(siteId) ?? null;
	}

	/** Every active site, one entry each, from the same cached table. */
	async allSites(): Promise<ResolvedSiteHost[]> {
		const { sites } = await this.#load();
		return [...sites.values()];
	}

	/** Discards the table so the next lookup reloads it. Call after changing sites or hostnames. */
	invalidate(): void {
		this.#table = null;
	}

	async #load(): Promise<SiteTable> {
		if (this.#table) return this.#table;
		const table = await this.#read();
		this.#table = table;
		return table;
	}

	#refreshInBackground(): void {
		if (this.#refreshing) return;
		this.#refreshing = true;
		const current = this.#table;
		// Started now, while this request's connection is open; after() only
		// keeps the request alive until it settles.
		const refresh = (async () => {
			try {
				const fresh = await this.#read();
				if (this.#table === current) this.#table = fresh;
			} catch (error) {
				console.error("[emdash:multisite] refreshing site hostnames failed:", error);
			} finally {
				this.#refreshing = false;
			}
		})();
		after(() => refresh);
	}

	async #read(): Promise<SiteTable> {
		const rows = await this.#db()
			.selectFrom("_emdash_sites as s")
			.leftJoin("_emdash_site_hosts as h", "h.site_id", "s.id")
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
		const sites = new Map<string, ResolvedSiteHost>();
		for (const row of rows) {
			const site = sites.get(row.id) ?? {
				siteId: row.id,
				orgId: row.org_id,
				name: row.name,
				primaryHostname: null,
				databaseRef: row.database_ref,
				storageRef: row.storage_ref,
			};
			if (row.hostname && (row.is_primary === 1 || site.primaryHostname === null)) {
				site.primaryHostname = row.hostname;
			}
			sites.set(row.id, site);
		}
		const hosts = new Map<string, ResolvedSiteHost>();
		for (const row of rows) {
			const site = sites.get(row.id);
			if (row.hostname && site) hosts.set(row.hostname, site);
		}
		return { hosts, sites };
	}
}
