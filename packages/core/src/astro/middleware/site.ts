/**
 * Request-to-site routing for multi-site deployments.
 *
 * Kept free of the virtual:emdash/* module graph so it can be unit-tested; the
 * middleware passes in the configured dialect factory.
 */

import { type Dialect, Kysely } from "kysely";

import { kyselyLogOption } from "../../database/instrumentation.js";
import { MultiSiteError } from "../../multisite/errors.js";
import { type ResolvedSiteHost, SiteHostResolver } from "../../multisite/hosts.js";
import { runControlPlaneMigrations } from "../../multisite/migrations.js";
import type { ControlPlaneDatabase } from "../../multisite/types.js";
import type { EmDashConfig, MultiSiteConfig } from "../integration/runtime.js";

/** The ref that names the `database` and `storage` options without overrides. */
export const DEFAULT_SITE_REF = "default";

/**
 * Request-context site id of the control plane when it serves the admin host.
 * Site ids are ULIDs, so this can't collide with one.
 */
export const CONTROL_PLANE_SITE_ID = "control-plane";

const DEFAULT_HOST_REFRESH_MS = 30_000;

export type MultiSiteDeploymentConfig = EmDashConfig & { multiSite: MultiSiteConfig };

export interface RequestSite {
	siteId: string;
	orgId: string;
	name: string;
	/** The deployment config with this site's database, storage, and URL applied. */
	config: EmDashConfig;
}

export interface SiteRouter {
	readonly controlPlane: Kysely<ControlPlaneDatabase>;
	/**
	 * The config the admin host runs with: the control-plane database, which
	 * holds accounts, sign-in, and sessions, and the admin URL as the site URL.
	 * Null when `multiSite.adminUrl` is not set.
	 */
	readonly adminConfig: EmDashConfig | null;
	/** The admin host's hostname, or null when `multiSite.adminUrl` is not set. */
	readonly adminHostname: string | null;
	/** The site serving `hostname`, or null when no active site lists it. */
	resolve(hostname: string): Promise<RequestSite | null>;
	/** An active site by id, or null. */
	siteById(siteId: string): Promise<RequestSite | null>;
	/** Every active site, for work that runs outside a request such as scheduled publishing. */
	activeSites(): Promise<RequestSite[]>;
	/** Drops cached hostnames so the next request reloads them. */
	invalidate(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeOptions(
	base: unknown,
	override: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return { ...(isRecord(base) ? base : {}), ...override };
}

function namedOptions(
	options: Record<string, Record<string, unknown>> | undefined,
	ref: string,
	kind: "database" | "storage",
): Record<string, unknown> | undefined {
	if (ref === DEFAULT_SITE_REF) return undefined;
	const named = options && Object.hasOwn(options, ref) ? options[ref] : undefined;
	if (!named) {
		throw new MultiSiteError(
			"NOT_FOUND",
			`Site ${kind} "${ref}" is not listed in multiSite.${kind === "database" ? "databases" : "storages"}`,
		);
	}
	return named;
}

const LOCAL_HOSTNAME = /(^|\.)localhost$/;

/**
 * The public origin of a site's primary hostname. Sites are served over HTTPS;
 * `localhost` hostnames, used in development, use the admin URL's scheme and
 * port so links work on a dev server.
 */
export function siteOrigin(hostname: string, adminUrl: string | undefined): string {
	if (LOCAL_HOSTNAME.test(hostname) && adminUrl) {
		const admin = new URL(adminUrl);
		return `${admin.protocol}//${hostname}${admin.port ? `:${admin.port}` : ""}`;
	}
	return `https://${hostname}`;
}

/** Applies a site's named database and storage options and URL to the deployment config. */
export function siteConfig(config: EmDashConfig, site: ResolvedSiteHost): EmDashConfig {
	const multiSite = config.multiSite;
	if (!multiSite) throw new Error("siteConfig requires multiSite to be configured");
	const database = config.database && {
		...config.database,
		config: mergeOptions(
			config.database.config,
			namedOptions(multiSite.databases, site.databaseRef, "database"),
		),
	};
	const storage =
		config.storage && site.storageRef !== null
			? {
					...config.storage,
					config: mergeOptions(
						config.storage.config,
						namedOptions(multiSite.storages, site.storageRef, "storage"),
					),
				}
			: config.storage;
	return {
		...config,
		database,
		storage,
		siteUrl: siteOrigin(site.primaryHostname, multiSite.adminUrl),
	};
}

export function createSiteRouter(
	config: MultiSiteDeploymentConfig,
	createDialect: (options: unknown) => Dialect,
): SiteRouter {
	const baseDatabase = config.database;
	if (!baseDatabase) {
		throw new Error("multiSite requires a database adapter to open the control-plane database");
	}
	const controlPlaneOptions = mergeOptions(baseDatabase.config, config.multiSite.controlPlane);
	const controlPlane = new Kysely<ControlPlaneDatabase>({
		dialect: createDialect(controlPlaneOptions),
		log: kyselyLogOption(),
	});
	const resolver = new SiteHostResolver(controlPlane, {
		refreshAfterMs: config.multiSite.hostRefreshMs ?? DEFAULT_HOST_REFRESH_MS,
	});
	const adminUrl = config.multiSite.adminUrl;
	const adminConfig: EmDashConfig | null = adminUrl
		? {
				...config,
				database: { ...baseDatabase, config: controlPlaneOptions },
				siteUrl: new URL(adminUrl).origin,
			}
		: null;
	const siteConfigs = new Map<string, { host: ResolvedSiteHost; config: EmDashConfig }>();
	let migrated: Promise<unknown> | null = null;

	const ensureMigrated = (): Promise<unknown> => {
		if (!migrated) {
			const pending = runControlPlaneMigrations(controlPlane);
			migrated = pending;
			pending.catch(() => {
				if (migrated === pending) migrated = null;
			});
		}
		return migrated;
	};

	const toRequestSite = (host: ResolvedSiteHost): RequestSite => {
		let cached = siteConfigs.get(host.siteId);
		if (
			!cached ||
			cached.host.databaseRef !== host.databaseRef ||
			cached.host.storageRef !== host.storageRef ||
			cached.host.primaryHostname !== host.primaryHostname
		) {
			cached = { host, config: siteConfig(config, host) };
			siteConfigs.set(host.siteId, cached);
		}
		return { siteId: host.siteId, orgId: host.orgId, name: host.name, config: cached.config };
	};

	return {
		controlPlane,
		adminConfig,
		adminHostname: adminUrl ? new URL(adminUrl).hostname : null,
		async resolve(hostname) {
			await ensureMigrated();
			const host = await resolver.resolve(hostname);
			return host ? toRequestSite(host) : null;
		},
		async siteById(siteId) {
			await ensureMigrated();
			const host = await resolver.findSite(siteId);
			return host ? toRequestSite(host) : null;
		},
		async activeSites() {
			await ensureMigrated();
			resolver.invalidate();
			const sites: RequestSite[] = [];
			for (const host of await resolver.allSites()) {
				try {
					sites.push(toRequestSite(host));
				} catch (error) {
					console.error(`[emdash:multisite] skipping site ${host.siteId}:`, error);
				}
			}
			return sites.toSorted((a, b) => a.siteId.localeCompare(b.siteId));
		},
		invalidate() {
			resolver.invalidate();
		},
	};
}

const ROUTER_KEY = Symbol.for("emdash:multi-site-router");
const store = globalThis as Record<symbol, unknown>;

/** The deployment's site router, created on first use and shared by every request in the worker. */
export function getSiteRouter(
	config: MultiSiteDeploymentConfig,
	createDialect: (options: unknown) => Dialect,
): SiteRouter {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot, written only below
	let router = store[ROUTER_KEY] as SiteRouter | undefined;
	if (!router) {
		router = createSiteRouter(config, createDialect);
		store[ROUTER_KEY] = router;
	}
	return router;
}
