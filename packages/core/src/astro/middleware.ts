/**
 * EmDash middleware
 *
 * Thin wrapper that initializes EmDashRuntime and attaches it to locals.
 * All heavy lifting happens in EmDashRuntime.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { defineMiddleware } from "astro:middleware";
import type { Kysely } from "kysely";
// Import from virtual modules (populated by integration at build time)
// @ts-ignore - virtual module
import { buildTime as virtualBuildTime } from "virtual:emdash/build";
// @ts-ignore - virtual module
import virtualConfig from "virtual:emdash/config";
// @ts-ignore - virtual module
import {
	createCoalescingDialect as virtualCreateCoalescingDialect,
	createDialect as virtualCreateDialect,
	createRequestScopedDb as virtualCreateRequestScopedDb,
} from "virtual:emdash/dialect";
import type { RequestScopedDbOpts } from "virtual:emdash/dialect";
// @ts-ignore - virtual module
import { mediaProviders as virtualMediaProviders } from "virtual:emdash/media-providers";
// @ts-ignore - virtual module
import { plugins as virtualPlugins } from "virtual:emdash/plugins";
// @ts-ignore - virtual module
import { createRoomHost as virtualCreateRoomHost } from "virtual:emdash/rooms";
// @ts-ignore - virtual module
import * as virtualSandboxRunnerModule from "virtual:emdash/sandbox-runner";
// @ts-ignore - virtual module
import { sandboxedPlugins as virtualSandboxedPlugins } from "virtual:emdash/sandboxed-plugins";
// @ts-ignore - virtual module
import { createScheduler as virtualCreateScheduler } from "virtual:emdash/scheduler";
// @ts-ignore - virtual module
import { createStorage as virtualCreateStorage } from "virtual:emdash/storage";

import { after } from "../after.js";
import { apiError } from "../api/error.js";
import { startUserSession } from "../auth/start-user-session.js";
import { EmDashConfigurationError } from "../config/errors.js";
import {
	createRecorder,
	flushRecorder,
	isInstrumentationEnabled,
} from "../database/instrumentation.js";
import {
	isMigrationRequiredError,
	PendingMigrationsError,
	resolveRuntimeMigrationMode,
	type RuntimeMigrationMode,
} from "../database/migrations/policy.js";
import { markRequestScopedDb } from "../database/request-scoped.js";
import { createDeferredTaskTracker } from "../deferred-tasks.js";
import {
	DB_INIT_DEADLINE_MS,
	EmDashRuntime,
	type RuntimeDependencies,
	type SandboxedPluginEntry,
	type MediaProviderEntry,
	type CreateSchedulerFn,
	type CreateRoomHostFn,
	type ScheduledTasksOptions,
} from "../emdash-runtime.js";
import { setI18nConfig } from "../i18n/config.js";
import type { Database, Storage } from "../index.js";
import { createPublicMediaUrlResolver } from "../media/url.js";
import { MultiSiteError } from "../multisite/errors.js";
import { consumeHandoff, createHandoff, safeReturnPath } from "../multisite/handoff.js";
import { normalizeHostname } from "../multisite/hosts.js";
import {
	type ControlPlaneUser,
	ensureSiteSetUp,
	findControlPlaneUser,
	refreshSiteAccount as refreshAccountFromControlPlane,
	siteRoleFor,
	syncSiteUser,
} from "../multisite/identity.js";
import { acceptOrgInvites, listSitesForUser } from "../multisite/repository.js";
import { getLastContentWriteAt } from "../object-cache/index.js";
import type { SandboxRunnerFactory } from "../plugins/sandbox/types.js";
import type { ResolvedPlugin } from "../plugins/types.js";
import { invalidateUrlPatternCache } from "../query.js";
import {
	createRequestMetrics,
	getRequestContext,
	type RequestMetrics,
	runOutsideRequestContext,
	runWithContext,
} from "../request-context.js";
import type { PublishedRef } from "../scheduled-publish.js";
import { parseCollectionSitemapName } from "../seo/sitemap-name.js";
import { currentSiteId, forgetSite, siteScopedGlobal } from "../site-scope.js";
import { EmDashStorageError } from "../storage/types.js";
import { isMissingTableError } from "../utils/db-errors.js";
import { initWithLock } from "../utils/init-lock.js";
import type { EmDashConfig } from "./integration/runtime.js";
import {
	ASTRO_COOKIES_SYMBOL,
	coordinateScopedDbLifecycle,
	finishScoped,
	requestEndedAuthenticated,
} from "./middleware/scoped-db.js";
import {
	claimEvictionPass,
	forgetSiteActivity,
	lastSiteUse,
	recordSiteUse,
} from "./middleware/site-lifecycle.js";
import {
	CONTROL_PLANE_SITE_ID,
	getSiteRouter,
	type RequestSite,
	type SiteRouter,
} from "./middleware/site.js";
import { wrapBodyForStreamMetrics } from "./middleware/stream-end-metrics.js";
import { prefetchLayoutData } from "./prefetch.js";
import {
	createPublicPluginApiRouteHandler,
	getPublicPluginRouteMeta,
} from "./public-plugin-api-routes.js";
import {
	getRuntimeHolder,
	hasSiteSweepTimer,
	heldSiteRuntimes,
	releaseSiteRuntime,
	setSiteSweepTimer,
} from "./runtime-holder.js";
import { resolveSessionUser } from "./session-user.js";
import type { EmDashHandlers } from "./types.js";

// Public type for withEmDashRuntime() consumers (queue/scheduled handlers).
export type { EmDashRuntime, ScheduledTasksOptions } from "../emdash-runtime.js";

/**
 * Runtime init lock reclaim deadline. Must be strictly larger than the db
 * init deadline: this lock wraps EmDashRuntime.create() → getDatabase() →
 * the db init lock, and equal deadlines would let this outer lock reclaim
 * (spawning a second cron scheduler and sandbox runner) while the inner db
 * init is legitimately still working through a contended migration.
 */
const RUNTIME_INIT_DEADLINE_MS = DB_INIT_DEADLINE_MS + 15_000;

/**
 * Throttle for the anonymous-path runtime-init failure log. While a site is
 * stuck (e.g. a failing migration in its backoff window, #1744) every
 * anonymous request lands in that catch; one line per interval per isolate
 * keeps the failure visible without flooding logs on a busy site. Plain
 * module state (not globalThis): a duplicated SSR chunk just means an extra
 * log line, which is harmless.
 */
const RUNTIME_INIT_ERROR_LOG_INTERVAL_MS = 30_000;
let lastRuntimeInitErrorLogAt = 0;

/**
 * Whether we've verified the database has been set up.
 * On a fresh deployment the first request may hit a public page, bypassing
 * runtime init. Without this check, template helpers like getSiteSettings()
 * would query an empty database and crash. Once verified (or once the runtime
 * has initialized via an admin/API request), this stays true for the worker's
 * lifetime.
 *
 * Stored on globalThis behind a Symbol key so the flag is a true singleton
 * even when the bundler duplicates this module across SSR chunks (same
 * pattern as request-cache.ts). A plain module-scoped `let` becomes multiple
 * independent variables, which would make the setup probe re-run far more
 * often than intended — and every re-run is another chance for a transient
 * DB error to be misread as "fresh install" and bounce visitors to setup.
 */
const SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified");
const setupFlagStore = globalThis as Record<symbol, unknown>;

const SITE_SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified:site");

function siteSetupFlag(): { verified: boolean } {
	return siteScopedGlobal(SITE_SETUP_VERIFIED_KEY, () => ({ verified: false }));
}

function isSetupVerified(): boolean {
	if (currentSiteId() !== undefined) return siteSetupFlag().verified;
	return setupFlagStore[SETUP_VERIFIED_KEY] === true;
}

function markSetupVerified(): void {
	if (currentSiteId() !== undefined) {
		siteSetupFlag().verified = true;
		return;
	}
	setupFlagStore[SETUP_VERIFIED_KEY] = true;
}

/** Nested request contexts copy this one, so call it before creating them. */
function providePublicMediaUrl(storage: Storage | null): (storageKey: string) => string {
	const resolve = createPublicMediaUrlResolver(storage);
	const ctx = getRequestContext();
	if (ctx) ctx.publicMediaUrl = resolve;
	return resolve;
}

/** Whether i18n config has been initialized from the virtual module */
let i18nInitialized = false;

/**
 * Get EmDash configuration from virtual module
 */
function getConfig(): EmDashConfig | null {
	if (virtualConfig && typeof virtualConfig === "object") {
		// Initialize i18n config on first access (once per worker lifetime)
		if (!i18nInitialized) {
			i18nInitialized = true;
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- virtual module checked as object above
			const config = virtualConfig as Record<string, unknown>;
			if (config.i18n && typeof config.i18n === "object") {
				setI18nConfig(
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-checked above
					config.i18n as {
						defaultLocale: string;
						locales: string[];
						fallback?: Record<string, string>;
					},
				);
			} else {
				setI18nConfig(null);
			}
		}

		return virtualConfig;
	}
	return null;
}

/**
 * Get plugins from virtual module
 */
function getPlugins(): ResolvedPlugin[] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- virtual module import is untyped (@ts-ignore above)
	const plugins = virtualPlugins as ResolvedPlugin[] | (() => ResolvedPlugin[]);
	return (typeof plugins === "function" ? plugins() : plugins) || [];
}

/**
 * Build runtime dependencies from virtual modules
 */
function buildDependencies(
	config: EmDashConfig,
	migrationMode: RuntimeMigrationMode,
): RuntimeDependencies {
	/* eslint-disable typescript-eslint/no-unsafe-type-assertion --
	   The virtual:emdash/* imports above use @ts-ignore because tsgo/IDE
	   resolution can't see virtual-modules.d.ts in every consumer setup,
	   so they arrive as `any`. The casts here line each entry up with
	   RuntimeDependencies's expected shape. The contract is enforced by
	   the integration that populates these virtual modules. */
	const sandboxModule = virtualSandboxRunnerModule as Record<string, unknown>;
	return {
		config,
		siteId: currentSiteId(),
		migrationMode,
		plugins: getPlugins(),
		createDialect: virtualCreateDialect as RuntimeDependencies["createDialect"],
		// Optional: only batching backends (D1, DO) export this; undefined otherwise.
		createCoalescingDialect:
			virtualCreateCoalescingDialect as RuntimeDependencies["createCoalescingDialect"],
		createStorage: virtualCreateStorage as ((config: Record<string, unknown>) => Storage) | null,
		// Sites in a multi-site deployment run their scheduled work from one
		// deployment-wide sweep (see ensureSiteSweep), not a timer per site.
		createScheduler:
			currentSiteId() === undefined ? (virtualCreateScheduler as CreateSchedulerFn | null) : null,
		createRoomHost: virtualCreateRoomHost as CreateRoomHostFn | null,
		sandboxEnabled: sandboxModule.sandboxEnabled as boolean,
		sandboxBypassed: (sandboxModule.sandboxBypassed as boolean) ?? false,
		sandboxedPluginEntries: (virtualSandboxedPlugins as SandboxedPluginEntry[]) || [],
		createSandboxRunner: sandboxModule.createSandboxRunner as SandboxRunnerFactory | null,
		mediaProviderEntries: (virtualMediaProviders as MediaProviderEntry[]) || [],
	};
	/* eslint-enable typescript-eslint/no-unsafe-type-assertion */
}

/**
 * Get or create the runtime instance.
 *
 * When `initTimings` is provided, any timing samples recorded during a
 * genuine cold init are appended. Subsequent warm calls (hitting the
 * cached instance) push nothing — callers should treat an empty array
 * as "warm, nothing to report".
 */
async function getRuntime(
	config: EmDashConfig,
	migrationMode: RuntimeMigrationMode,
	initTimings?: Array<{ name: string; dur: number; desc?: string }>,
): Promise<EmDashRuntime> {
	// Waiters poll rather than awaiting the initializing request's promise —
	// workerd flags cross-request promise resolution (warnings + potential
	// hangs). If the initializing request is cancelled mid-create (client
	// disconnect tears down its continuation, skipping any `finally`), the
	// anchored init keeps running under waitUntil and populates the cache;
	// failing that, the stale lock is reclaimed after a deadline instead of
	// hanging every subsequent request in the isolate until eviction.
	const holder = getRuntimeHolder(currentSiteId());
	return initWithLock(
		holder.lock,
		() => {
			if (holder.closed) throw new Error("EmDash dev server has closed");
			return holder.instance;
		},
		async (isCurrentClaim) => {
			if (holder.closed) throw new Error("EmDash dev server has closed");
			const deps = buildDependencies(config, migrationMode);
			const runtime = await EmDashRuntime.create(deps, initTimings);
			// A restart can close the server while the first request is initializing.
			if (holder.closed) {
				await runtime.shutdown();
				throw new Error("EmDash dev server has closed");
			}
			if (isCurrentClaim()) {
				holder.instance = runtime;
				runtime.rooms?.activate();
			} else {
				// This init was reclaimed mid-flight (it ran past the deadline
				// and a waiter started its own). Don't overwrite the
				// reclaimer's published runtime, and stop this one's cron
				// scheduler so it doesn't keep firing unreferenced. The
				// runtime is still returned — it's fully functional for the
				// request that built it.
				runtime.stopCron().catch((error: unknown) => {
					console.error("[emdash] failed to stop superseded runtime's cron:", error);
				});
				runtime.rooms?.shutdown().catch((error: unknown) => {
					console.error("[co-editing] failed to shut down superseded runtime's rooms:", error);
				});
			}
			return runtime;
		},
		{
			deadlineMs: RUNTIME_INIT_DEADLINE_MS,
			anchor: (promise) => after(() => promise),
		},
	);
}

/**
 * Run scheduled maintenance (cron tasks, scheduled publishing, system cleanup)
 * outside any request. Resolves the runtime from the build-time virtual config
 * and the cached singleton — the same instance request handlers use.
 *
 * Wired into a platform heartbeat that is not a request: the Cloudflare Worker's
 * `scheduled()` handler (Cron Trigger) calls this. On Node the runtime's own
 * timer-based scheduler already drives the same work, so this isn't needed there.
 *
 * Returns the content promoted by the publishing sweep so the caller can purge
 * edge-cache tags for it. `onPublished` (optional) is awaited after each
 * collection's batch so the caller can invalidate edge-cache tags incrementally
 * rather than only after the whole sweep. `publishUpcomingWithinMs` keeps the
 * run open to publish content scheduled within that window at its exact time.
 */
export async function runScheduledTasks(
	options: ScheduledTasksOptions = {},
): Promise<{ published: PublishedRef[] }> {
	const config = getConfig();
	if (!config) return { published: [] };
	if (!config.multiSite) {
		return runOutsideRequest(config, (runtime) => runtime.runScheduledTasks(options));
	}
	if (typeof virtualCreateDialect !== "function") {
		throw new Error("multiSite requires a database adapter");
	}
	const router = getSiteRouter({ ...config, multiSite: config.multiSite }, virtualCreateDialect);
	const published: PublishedRef[] = [];
	const sites = await router.activeSites();
	if (router.adminConfig) {
		sites.unshift({
			siteId: CONTROL_PLANE_SITE_ID,
			orgId: "",
			name: "",
			config: router.adminConfig,
		});
	}
	for (const site of sites) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- sequential on purpose, see above
			const result = await runOutsideRequest(
				site.config,
				(runtime) => runtime.runScheduledTasks(options),
				site.siteId,
			);
			published.push(...result.published);
		} catch (error) {
			console.error(`[emdash:multisite] scheduled tasks failed for site ${site.siteId}:`, error);
		}
	}
	return { published };
}

/**
 * Run a callback against the EmDash runtime outside any HTTP request — from a
 * Cloudflare Queue consumer, a `scheduled()` handler, or any other
 * platform-event handler that has no request and therefore no `locals.emdash`.
 *
 * Resolves the same cached runtime singleton request handlers use, so hooks,
 * plugin state, and storage all behave exactly as they do during a request.
 * A typical queue consumer finishes a job by calling back into a plugin route:
 *
 * ```ts
 * import { withEmDashRuntime } from "emdash/middleware";
 *
 * async function queue(batch: MessageBatch) {
 * 	await withEmDashRuntime(async (runtime) => {
 * 		for (const message of batch.messages) {
 * 			await runtime.handlePluginApiRoute(
 * 				"my-plugin",
 * 				"POST",
 * 				"/finishJob",
 * 				new Request("https://internal/", {
 * 					method: "POST",
 * 					body: JSON.stringify(message.body),
 * 				}),
 * 			);
 * 		}
 * 	});
 * }
 * ```
 *
 * Server-only and fully trusted: the callback gets the raw runtime with no
 * auth or CSRF checks, same trust level as plugin cron. Never expose it to
 * user input without validating that input yourself.
 *
 * Throws when EmDash is not configured (no `emdash()` Astro integration).
 */
export async function withEmDashRuntime<T>(
	run: (runtime: EmDashRuntime) => T | Promise<T>,
): Promise<T> {
	const config = getConfig();
	if (!config) {
		throw new Error(
			"EmDash is not configured — withEmDashRuntime() requires the emdash() Astro integration.",
		);
	}
	return runOutsideRequest(config, async (runtime) => run(runtime));
}

/**
 * Shared plumbing for request-free entry points (`runScheduledTasks`,
 * `withEmDashRuntime`): resolve the runtime singleton, then run the callback
 * under an event-scoped db when the adapter needs one.
 *
 * Connection-backed adapters (e.g. Postgres over Hyperdrive) cannot reuse
 * the per-isolate singleton from a platform event: its socket belongs to the
 * request that opened it, and workerd rejects cross-event I/O. Open an
 * event-scoped connection and run the callback under it in ALS — the
 * runtime's db getter, the cron executor, and plugin contexts all resolve
 * the connection from ALS — then close it when required. Stateless adapters
 * that need primary routing can return a close-less scope; adapters with no
 * event scoping return null and keep using the singleton.
 */
async function runOutsideRequest<T>(
	config: EmDashConfig,
	fn: (runtime: EmDashRuntime) => Promise<T>,
	siteId?: string,
): Promise<T> {
	const migrationMode = resolveConfiguredMigrationMode(config);
	const parent = getRequestContext();
	if (parent) {
		if (siteId === undefined) {
			const runtime = await getRuntime(config, migrationMode);
			return runOutsideRequestWithRuntime(config, runtime, fn);
		}
		return runWithContext({ ...parent, siteId }, async () => {
			const runtime = await getRuntime(config, migrationMode);
			return runWithContext({ ...parent, siteId, db: runtime.db }, () =>
				runOutsideRequestWithRuntime(config, runtime, fn),
			);
		});
	}

	const deferredTasks = createDeferredTaskTracker(() => {});
	const context = {
		editMode: false,
		metrics: createRequestMetrics(performance.now()),
		deferredTasks,
		siteId,
	};
	return runWithContext(context, async () => {
		const runtime = await (async () => {
			try {
				return await getRuntime(config, migrationMode);
			} finally {
				deferredTasks.settle();
				await deferredTasks.settled;
			}
		})();
		if (siteId === undefined) return runOutsideRequestWithRuntime(config, runtime, fn);
		return runWithContext({ ...context, db: runtime.db }, () =>
			runOutsideRequestWithRuntime(config, runtime, fn),
		);
	});
}

async function runOutsideRequestWithRuntime<T>(
	config: EmDashConfig,
	runtime: EmDashRuntime,
	fn: (runtime: EmDashRuntime) => Promise<T>,
): Promise<T> {
	const scoped = createRequestScopedDb({
		config: config.database?.config,
		isAuthenticated: false,
		// Event handlers publish, clean up, or run jobs — a write workload —
		// so a connection-backed adapter routes them to the primary.
		isWrite: true,
		canUseCachedBinding: false,
		cookies: NOOP_COOKIE_JAR,
		url: CRON_EVENT_URL,
	});
	if (!scoped) {
		// This adapter needs no event-specific routing or connection.
		return fn(runtime);
	}
	const { closed, deferredTasks, lifecycle } = coordinateScopedDbLifecycle(scoped);

	const parent = getRequestContext();
	const ctx = parent
		? { ...parent, db: scoped.db, deferredTasks }
		: {
				editMode: false,
				db: scoped.db,
				metrics: createRequestMetrics(performance.now()),
				deferredTasks,
			};
	try {
		return await runWithContext(ctx, () => fn(runtime));
	} finally {
		// Guard both so a throw in teardown can't mask the callback result or
		// skip lifecycle settlement and leak the connection.
		try {
			lifecycle.commit();
		} catch (error) {
			console.error("[emdash] event-scoped db commit failed:", error);
		}
		try {
			lifecycle.close?.();
		} catch (error) {
			console.error("[emdash] event-scoped db close failed:", error);
		}
		await closed;
	}
}

/**
 * A cookie jar that reads nothing and writes nothing, for request-scoped db
 * adapters invoked outside an HTTP request (the Cron Trigger sweep). Connection
 * adapters like Hyperdrive ignore cookies entirely; the D1 session adapter
 * reads/writes a bookmark cookie, but cron never reaches that path (it has no
 * `close()`), so the no-ops are never observed.
 */
const NOOP_COOKIE_JAR = {
	get: () => undefined,
	set: () => {},
};

/**
 * Synthetic URL for the cron sweep's request-scoped db opts. Only the D1
 * session adapter inspects `url` (for cookie `secure`), and cron doesn't take
 * that path, so the value is never used — it exists to satisfy the contract.
 */
const CRON_EVENT_URL = new URL("https://cron.emdash.internal/");

function resolveConfiguredMigrationMode(config: EmDashConfig): RuntimeMigrationMode {
	const processOverride =
		typeof process !== "undefined" && process.env ? process.env.EMDASH_MIGRATIONS_MODE : undefined;
	const importMetaOverride = import.meta.env.EMDASH_MIGRATIONS_MODE;
	return resolveRuntimeMigrationMode(config.migrations, {
		dev: import.meta.env.DEV,
		override: processOverride ?? importMetaOverride,
	});
}

function pendingMigrationsResponse(error: PendingMigrationsError): Response {
	console.error("[emdash] database migrations are pending:", error.pending.join(", "));
	return migrationRequiredResponse();
}

function migrationRequiredErrorResponse(error: unknown): Response {
	if (error instanceof PendingMigrationsError) return pendingMigrationsResponse(error);
	if (Date.now() - lastRuntimeInitErrorLogAt >= RUNTIME_INIT_ERROR_LOG_INTERVAL_MS) {
		lastRuntimeInitErrorLogAt = Date.now();
		console.error(
			"[emdash] database migrations are required:",
			error instanceof Error ? error.message : error,
		);
	}
	return migrationRequiredResponse();
}

function migrationRequiredResponse(): Response {
	return new Response(
		"Database migrations are required. Apply the deployment migration manifest and retry.",
		{
			status: 503,
			headers: { "Retry-After": "60" },
		},
	);
}

function unmigratedDatabaseResponse(): Response {
	return new Response(
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Site unavailable</title></head><body><p>This site\'s database has not been migrated yet. <a href="/_emdash/admin/setup">Set up EmDash</a></p></body></html>',
		{
			status: 503,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Retry-After": "60",
			},
		},
	);
}

function runtimeConfigurationErrorResponse(error: unknown, pathname: string): Response | null {
	if (!pathname.startsWith("/_emdash/api/")) return null;
	if (error instanceof EmDashConfigurationError) {
		return apiError(error.code, error.message, 500);
	}
	if (error instanceof EmDashStorageError && error.code === "BINDING_NOT_FOUND") {
		return apiError(error.code, error.message, 500);
	}
	return null;
}

/**
 * Baseline security headers applied to all responses.
 * Admin routes get additional headers (strict CSP) from auth middleware.
 */
function finalizeResponse(
	response: Response,
	serverTimings?: Array<{ name: string; dur: number; desc?: string }>,
): Response {
	const res = new Response(response.body, response);
	const astroCookies = Reflect.get(response, ASTRO_COOKIES_SYMBOL);
	if (astroCookies !== undefined) {
		Reflect.set(res, ASTRO_COOKIES_SYMBOL, astroCookies);
	}
	// Set-if-absent so a host app that sets stricter values on its own routes
	// wins. The middleware registers `order: 'pre'` (#1282), so on the response
	// path it runs *after* host middleware; unconditional `set()` would clobber
	// the host's headers on every public route (#1393). Mirrors the CSP guard.
	if (!res.headers.has("X-Content-Type-Options")) {
		res.headers.set("X-Content-Type-Options", "nosniff");
	}
	if (!res.headers.has("Referrer-Policy")) {
		res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	}
	if (!res.headers.has("Permissions-Policy")) {
		res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	}
	if (!res.headers.has("Content-Security-Policy")) {
		res.headers.set("X-Frame-Options", "SAMEORIGIN");
	}
	if (serverTimings && serverTimings.length > 0) {
		res.headers.set(
			"Server-Timing",
			serverTimings
				.map((t) => {
					const dur = Math.round(t.dur);
					return t.desc ? `${t.name};dur=${dur};desc="${t.desc}"` : `${t.name};dur=${dur}`;
				})
				.join(", "),
		);
	}
	return res;
}

/**
 * Append always-on counters (db.*, cache.*) to the Server-Timing list.
 *
 * dur values for `count`, `hit`, `miss` are integer counts — Server-Timing
 * spec only models milliseconds, but browsers show whatever number is given,
 * which is the convention most projects use for non-time samples.
 */
function pushMetricsTimings(
	timings: Array<{ name: string; dur: number; desc?: string }>,
	metrics: RequestMetrics,
): void {
	if (metrics.dbCount > 0) {
		timings.push({ name: "db.total", dur: metrics.dbTotalMs, desc: "DB total" });
		timings.push({ name: "db.count", dur: metrics.dbCount, desc: "Query count" });
		if (metrics.dbFirstOffset !== null) {
			timings.push({ name: "db.first", dur: metrics.dbFirstOffset, desc: "First query at" });
		}
		if (metrics.dbLastOffset !== null) {
			timings.push({ name: "db.last", dur: metrics.dbLastOffset, desc: "Last query at" });
		}
	}
	if (metrics.rpcCount > 0) {
		timings.push({ name: "rpc.count", dur: metrics.rpcCount, desc: "DB round trips" });
	}
	if (metrics.cacheHits + metrics.cacheMisses > 0) {
		timings.push({ name: "cache.hit", dur: metrics.cacheHits, desc: "Cache hits" });
		timings.push({ name: "cache.miss", dur: metrics.cacheMisses, desc: "Cache misses" });
	}
}

const TRAILING_SLASH_RE = /\/$/;

/** Public routes that require the runtime (sitemap, robots.txt, etc.) */
const PUBLIC_RUNTIME_ROUTES = new Set(["/sitemap.xml", "/robots.txt"]);
const SITEMAP_COLLECTION_RE = /^\/sitemap-([^/]+)\.xml$/;

/** Whether `pathname` is a per-collection sitemap a collection could have. */
function isCollectionSitemapPath(pathname: string): boolean {
	const match = SITEMAP_COLLECTION_RE.exec(pathname);
	return match !== null && parseCollectionSitemapName(match[1]!) !== null;
}

function isImageEndpointRequest(context: APIContext): boolean {
	const route = virtualConfig?.imageEndpointRoute;
	return typeof route === "string" && context.routePattern === route;
}

/** The runtime's storage adapter, or null when none is configured or it cannot be created. */
function tryGetStorage(config: EmDashConfig, migrationMode: RuntimeMigrationMode): Storage | null {
	try {
		return EmDashRuntime.getStorage(buildDependencies(config, migrationMode));
	} catch {
		return null;
	}
}

/**
 * Run an image endpoint request on the adapter's request-scoped db. Anything
 * on its path that queries (host middleware, the redirect middleware under a
 * custom endpoint route) must not fall back to the per-isolate singleton: a
 * request-bound connection (pg over Hyperdrive) reused by another request fails
 * or hangs on workerd's cross-request I/O guard. A signed-in request also gets
 * the db as `locals.emdash.db`, which the auth middleware resolves `locals.user`
 * with.
 *
 * The adapter's `commit()` is skipped: on D1 it sets the bookmark cookie, and a
 * response that sets a cookie is never stored by Workers Cache. This assumes
 * nothing on the image path writes data the client must read back; the
 * bookmark it sent still covers its earlier writes.
 */
async function runImageRequest(
	config: EmDashConfig,
	context: APIContext,
	imageLocals: EmDashHandlers,
	signedIn: boolean,
	metrics: RequestMetrics,
	next: () => Promise<Response>,
): Promise<Response> {
	const scoped = createRequestScopedDb({
		config: config.database?.config,
		isAuthenticated: signedIn,
		isWrite: false,
		canUseCachedBinding: false,
		cookies: context.cookies,
		url: context.url,
	});
	if (!scoped) {
		if (signedIn) {
			try {
				const { getDb } = await import("../loader.js");
				imageLocals.db = await getDb();
			} catch (error) {
				console.error("[emdash] image request could not open the database:", error);
			}
		}
		return finalizeResponse(await next());
	}
	if (signedIn) imageLocals.db = scoped.db;
	const { deferredTasks, lifecycle } = coordinateScopedDbLifecycle({ ...scoped, commit: () => {} });
	const parent = getRequestContext();
	const ctx = parent
		? { ...parent, db: scoped.db, deferredTasks }
		: { editMode: false, db: scoped.db, metrics, deferredTasks };
	return runWithContext(ctx, () =>
		finishScoped(lifecycle, async () => finalizeResponse(await next())),
	);
}

/**
 * Ask the configured database adapter for a per-request scoped Kysely. The
 * adapter encapsulates any per-request semantics (D1 sessions, read-replica
 * routing, bookmark cookies, etc.); core just forwards the cookie jar and
 * request flags, registers the returned handle as a view of the configured
 * database, and wraps next() in ALS if a scope was returned.
 */
function createRequestScopedDb(
	opts: RequestScopedDbOpts,
): { db: Kysely<Database>; commit: () => void; close?: () => void } | null {
	if (typeof virtualCreateRequestScopedDb !== "function") return null;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- adapter returns Kysely<unknown>; cast to Database since core owns that type
	const fn = virtualCreateRequestScopedDb as (
		o: RequestScopedDbOpts,
	) => { db: Kysely<Database>; commit: () => void; close?: () => void } | null;
	const scoped = fn(opts);
	if (scoped) markRequestScopedDb(scoped.db);
	return scoped;
}

const buildDate = virtualBuildTime ? new Date(virtualBuildTime) : null;

/**
 * Fold the build timestamp into the route cache validator.
 *
 * `CacheHint.lastModified` describes the content, but the response also depends
 * on the build: `/_astro/*` names are content-hashed, and a deployment only
 * serves its own. Without the build dimension a code-only deploy answers a
 * returning visitor's conditional request with 304, leaving them on HTML whose
 * assets 404.
 *
 * Only a route that set a content validator gets the build dimension. The build
 * alone does not move when content is published, so as a page's only validator
 * it would answer every returning visitor with 304 until the next deploy.
 *
 * Prerendered pages are served by the host's static layer, which manages its
 * own validators — only on-demand responses need the build dimension.
 *
 * Only forward moves are covered. `Last-Modified` expresses newer, not
 * different, so after a rollback the earlier build still answers a conditional
 * request with 304 and the browser stays on the newer build's HTML.
 *
 * Must run after next(), once the route has set its hint. Astro keeps the later
 * of two dates, so a route's own hint still wins when content is newer.
 * `Astro.cache.set(false)` also clears `lastModified`, so for an opted-out
 * route the guard skips the build `set()` below, which would re-enable caching.
 */
function applyBuildValidator(context: APIContext): void {
	if (context.isPrerendered || !buildDate || !context.cache?.enabled) return;
	if (!context.cache.options.lastModified) return;
	context.cache.set({ lastModified: buildDate });
}

const UNSHARED_CACHE_CONTROL_RE = /\b(?:private|no-store)\b/i;

/**
 * Route rules match by path, so a rule can cover responses rendered for a
 * signed-in user or marked private by the route itself. Opting them out of the
 * route cache keeps the shared edge cache from serving them to anyone else.
 *
 * Must run after next(): the route and its layout call `cache.set()` while
 * rendering, which turns caching back on.
 */
function keepUnsharedResponsesOutOfRouteCache(context: APIContext, response: Response): void {
	if (!context.cache?.enabled) return;
	if (
		context.locals.user ||
		UNSHARED_CACHE_CONTROL_RE.test(response.headers.get("Cache-Control") ?? "")
	) {
		context.cache.set(false);
	}
}

const ANONYMOUS_RENDER = Symbol.for("emdash:anonymous-render");

type RenderLocals = App.Locals & {
	[ANONYMOUS_RENDER]?: {
		method: string;
		db: unknown;
		metrics: RequestMetrics | undefined;
	};
};

function getPublicPageSignals(context: APIContext) {
	const { url, cookies } = context;
	const base = import.meta.env.BASE_URL.replace(TRAILING_SLASH_RE, "");
	const publicPath =
		base && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
	return {
		publicPath,
		isEmDashRoute: url.pathname.startsWith("/_emdash"),
		isPublicRuntimeRoute:
			PUBLIC_RUNTIME_ROUTES.has(publicPath) || isCollectionSitemapPath(publicPath),
		hasEditCookie: !context.isPrerendered && cookies.get("emdash-edit-mode")?.value === "true",
		hasPreviewToken: url.searchParams.has("_preview"),
		hasSessionCookie:
			!context.isPrerendered &&
			cookies.get(virtualConfig?.sessionCookieName ?? "astro-session") !== undefined,
		playgroundDb: context.locals.__playgroundDb,
	};
}

function isAnonymousPublicPage(
	signals: ReturnType<typeof getPublicPageSignals>,
	hasSession: boolean,
): boolean {
	return (
		!signals.isEmDashRoute &&
		!signals.isPublicRuntimeRoute &&
		!signals.hasEditCookie &&
		!signals.hasPreviewToken &&
		!hasSession &&
		!signals.playgroundDb
	);
}

function canReuseAnonymousRender(context: APIContext): boolean {
	const original = (context.locals as RenderLocals)[ANONYMOUS_RENDER];
	const parent = getRequestContext();
	if (!original || !parent) return false;
	if (context.request.method !== original.method) return false;
	if (context.locals.user || parent.editMode || parent.preview) return false;
	if (parent.db !== original.db || parent.metrics !== original.metrics) return false;
	if (context.request.headers.has("authorization")) return false;
	const signals = getPublicPageSignals(context);
	// A rewrite may have acquired a session cookie since the original anonymous render.
	if (!isAnonymousPublicPage(signals, signals.hasSessionCookie)) return false;
	if (isImageEndpointRequest(context)) return false;
	// A newly cacheable target must not reuse data loaded from an unverified object-cache snapshot.
	if (virtualConfig?.objectCacheEnabled && context.cache?.enabled && !parent.routeCacheFill) {
		return false;
	}
	return true;
}

const SITE_NOT_FOUND_HEADERS = {
	"Content-Type": "text/plain; charset=utf-8",
	"Cache-Control": "private, no-store",
};

/** Cookie that remembers which site the shared admin is managing. */
const ADMIN_SITE_COOKIE = "emdash-site";

/** Header that names the site an API request on the admin host is for. */
const SITE_HEADER = "X-EmDash-Site";

function siteUnavailableResponse(): Response {
	return finalizeResponse(
		new Response("Site temporarily unavailable", { status: 503, headers: SITE_NOT_FOUND_HEADERS }),
	);
}

const EVICTION_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_SITE_TTL_MS = 10 * 60_000;
const SITE_SWEEP_INTERVAL_MS = 60_000;

/**
 * How long a site may go without requests before it is released. Long-running
 * servers keep every site loaded by default: their per-minute sweep would
 * reopen a released site anyway.
 */
function idleSiteTtl(config: EmDashConfig): number {
	const configured = config.multiSite?.idleSiteTtlMs;
	if (configured !== undefined) return configured;
	return virtualCreateScheduler ? 0 : DEFAULT_IDLE_SITE_TTL_MS;
}

/**
 * Releases sites that have served no request within the idle TTL: their
 * runtime, database connection, storage adapter, and cache slots. Runs after
 * the response, at most once a minute per worker.
 */
function scheduleIdleSiteEviction(config: EmDashConfig, activeSiteId: string): void {
	const ttl = idleSiteTtl(config);
	if (ttl <= 0) return;
	const now = Date.now();
	if (!claimEvictionPass(now, EVICTION_CHECK_INTERVAL_MS)) return;
	after(async () => {
		for (const siteId of heldSiteRuntimes()) {
			if (siteId === activeSiteId || siteId === CONTROL_PLANE_SITE_ID) continue;
			if (now - lastSiteUse(siteId) < ttl) continue;
			try {
				// oxlint-disable-next-line no-await-in-loop -- one site at a time keeps shutdown work bounded
				await releaseSiteRuntime(siteId);
			} catch (error) {
				console.error(`[emdash:multisite] shutting down idle site ${siteId} failed:`, error);
			}
			EmDashRuntime.releaseSite(siteId);
			forgetSite(siteId);
			forgetSiteActivity(siteId);
		}
	});
}

/**
 * On long-running servers, runs every site's scheduled work once a minute,
 * as Cloudflare's Cron Trigger does through `runScheduledTasks()`. Site
 * runtimes start no timers of their own, so a site with no traffic still
 * publishes on time.
 */
function ensureSiteSweep(): void {
	if (!virtualCreateScheduler || hasSiteSweepTimer()) return;
	const timer = runOutsideRequestContext(() =>
		setInterval(() => {
			runScheduledTasks().catch((error: unknown) => {
				console.error("[emdash:multisite] scheduled sweep failed:", error);
			});
		}, SITE_SWEEP_INTERVAL_MS),
	);
	if (typeof timer === "object" && "unref" in timer) timer.unref();
	setSiteSweepTimer(timer);
}

/**
 * Runs `fn` as the given site: with its id in the request context, its runtime
 * initialized, and its database in the request context, so every cache and
 * query below sees only that site. The runtime is initialized before anything
 * reads the database, because the loader's `getDb()` would otherwise fall back
 * to the default database.
 */
async function runAsSite(
	siteId: string,
	siteConfig: EmDashConfig,
	fn: (runtime: EmDashRuntime) => Promise<Response>,
): Promise<Response> {
	const migrationMode = resolveConfiguredMigrationMode(siteConfig);
	const parent = getRequestContext();
	const siteContext = parent ? { ...parent, siteId } : { editMode: false, siteId };
	if (siteId !== CONTROL_PLANE_SITE_ID) {
		recordSiteUse(siteId);
		scheduleIdleSiteEviction(siteConfig, siteId);
	}
	return runWithContext(siteContext, async () => {
		let runtime: EmDashRuntime;
		try {
			runtime = await getRuntime(siteConfig, migrationMode);
		} catch (error) {
			if (isMigrationRequiredError(error)) return migrationRequiredErrorResponse(error);
			if (migrationMode === "manual" && isMissingTableError(error)) {
				return migrationRequiredResponse();
			}
			console.error("[emdash:multisite] site runtime init failed:", error);
			return siteUnavailableResponse();
		}
		return runWithContext({ ...siteContext, db: runtime.db }, () => fn(runtime));
	});
}

/**
 * Admin-host paths that always run against the control plane: sign-in,
 * account and passkey management, first-run setup, and anything outside the
 * admin and API. `/auth/me` reports the user's role on the selected site, so
 * it runs as that site.
 */
function isControlPlanePath(pathname: string): boolean {
	if (!pathname.startsWith("/_emdash/")) return true;
	if (pathname === "/_emdash/api/auth/me" || pathname === "/_emdash/api/auth/me/") return false;
	return (
		pathname.startsWith("/_emdash/api/auth/") ||
		pathname.startsWith("/_emdash/api/setup") ||
		pathname.startsWith("/_emdash/api/multisite/") ||
		pathname.startsWith("/_emdash/admin/setup") ||
		pathname.startsWith("/_emdash/.well-known/")
	);
}

const HANDOFF_START_PATH = "/_emdash/api/multisite/handoff";
const HANDOFF_COMPLETE_PATH = "/_emdash/api/multisite/handoff/complete";
const HANDOFF_HEADERS = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
};

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Issues a single-use token that signs the admin host's user in on a site's
 * own hostname, for visual editing and previews there. Called by the admin
 * with a POST, so another website can't start a handoff for the visitor.
 */
async function startHandoff(
	context: APIContext,
	router: SiteRouter,
	user: ControlPlaneUser,
): Promise<Response> {
	if (context.request.method !== "POST") {
		return finalizeResponse(apiError("METHOD_NOT_ALLOWED", "Use POST", 405));
	}
	if (context.request.headers.get("X-EmDash-Request") !== "1") {
		return finalizeResponse(apiError("CSRF_REJECTED", "Missing required header", 403));
	}
	const siteId = context.url.searchParams.get("site");
	const site = siteId ? await router.siteById(siteId) : null;
	const role = site ? await siteRoleFor(router.controlPlane, user, site.siteId) : null;
	if (!site || role === null || !site.config.siteUrl) {
		return finalizeResponse(apiError("NOT_FOUND", "Site not found", 404));
	}
	const token = await createHandoff(router.controlPlane, { userId: user.id, siteId: site.siteId });
	const target = new URL(HANDOFF_COMPLETE_PATH, site.config.siteUrl);
	target.searchParams.set("token", token);
	target.searchParams.set("redirect", safeReturnPath(context.url.searchParams.get("redirect")));
	return finalizeResponse(
		Response.json({ data: { url: target.href } }, { headers: HANDOFF_HEADERS }),
	);
}

/**
 * Redeems a handoff token on a site's hostname and starts the site's own
 * session. Opening the link shows a page that names the site and asks the
 * visitor to continue; only that page's POST, from the site's own origin,
 * redeems the token. A link alone can't sign someone in as another account.
 */
async function completeHandoff(
	context: APIContext,
	router: SiteRouter,
	site: RequestSite,
	siteDb: Kysely<Database>,
): Promise<Response> {
	const siteOrigin = site.config.siteUrl ? new URL(site.config.siteUrl).origin : context.url.origin;
	if (context.request.method === "GET") {
		const token = context.url.searchParams.get("token") ?? "";
		const returnPath = safeReturnPath(context.url.searchParams.get("redirect"));
		const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to ${escapeHtml(site.name)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Sign in to ${escapeHtml(site.name)}</h1>
<p>Continue to open this site signed in with your EmDash account.</p>
<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="redirect" value="${escapeHtml(returnPath)}"><button type="submit">Continue</button></form>
</body></html>`;
		return finalizeResponse(
			new Response(html, {
				headers: { "Content-Type": "text/html; charset=utf-8", ...HANDOFF_HEADERS },
			}),
		);
	}
	if (context.request.method !== "POST") {
		return finalizeResponse(apiError("METHOD_NOT_ALLOWED", "Use GET or POST", 405));
	}
	if (context.request.headers.get("Origin") !== siteOrigin) {
		return finalizeResponse(apiError("CSRF_REJECTED", "Sign-in must come from this site", 403));
	}
	const form = await context.request.formData().catch(() => null);
	const token = form?.get("token");
	const redirect = form?.get("redirect");
	const returnPath = safeReturnPath(typeof redirect === "string" ? redirect : null);
	const userId =
		typeof token === "string" && token
			? await consumeHandoff(router.controlPlane, token, site.siteId)
			: null;
	const role = userId
		? await refreshAccountFromControlPlane(
				router.controlPlane,
				router.controlAccounts,
				siteDb,
				site.siteId,
				userId,
			)
		: null;
	if (!userId || role === null || !context.session) {
		return finalizeResponse(apiError("INVALID_TOKEN", "Sign-in link is invalid or expired", 400));
	}
	await startUserSession(siteDb, context.session, userId);
	return finalizeResponse(
		new Response(null, { status: 303, headers: { Location: returnPath, ...HANDOFF_HEADERS } }),
	);
}

/**
 * The site a signed-in user manages on the admin host: the one named by the
 * `site` query parameter or the site cookie when the user can reach it,
 * otherwise the first site they can reach. Null when they can reach none.
 */
async function selectAdminSite(
	context: APIContext,
	router: SiteRouter,
	user: ControlPlaneUser,
): Promise<(RequestSite & { role: RoleLevel }) | null> {
	const requested =
		(context.url.pathname.startsWith("/_emdash/admin") && context.url.searchParams.get("site")) ||
		context.cookies.get(ADMIN_SITE_COOKIE)?.value;
	if (requested) {
		const site = await router.siteById(requested);
		const role = site ? await siteRoleFor(router.controlPlane, user, site.siteId) : null;
		if (site && role !== null) return { ...site, role };
	}
	const candidates =
		user.role >= Role.ADMIN
			? (await router.activeSites()).map((site) => site.siteId)
			: (await listSitesForUser(router.controlPlane, user.id)).map((site) => site.id);
	for (const siteId of candidates) {
		// oxlint-disable-next-line no-await-in-loop -- stops at the first reachable site
		const site = await router.siteById(siteId);
		// oxlint-disable-next-line no-await-in-loop -- see above
		const role = site ? await siteRoleFor(router.controlPlane, user, siteId) : null;
		if (site && role !== null) return { ...site, role };
	}
	return null;
}

/**
 * Requests to the shared admin host. Sign-in and setup run against the control
 * plane. Admin and API requests from a signed-in user run as the site they
 * are managing, after copying their account into that site with the role they
 * hold there, so the rest of EmDash reads the user from the site as usual.
 */
async function routeAdminHost(
	context: APIContext,
	router: SiteRouter,
	adminConfig: EmDashConfig,
	run: (config: EmDashConfig | null) => Promise<Response>,
): Promise<Response> {
	const { pathname } = context.url;
	const bearer = (context.request.headers.get("authorization") ?? "")
		.toLowerCase()
		.startsWith("bearer ");
	if (bearer && pathname.startsWith("/_emdash/api/") && !isControlPlanePath(pathname)) {
		const requested = context.request.headers.get(SITE_HEADER);
		const site = requested ? await router.siteById(requested) : null;
		if (!site) {
			return finalizeResponse(
				apiError(
					"SITE_REQUIRED",
					`Send API requests to the site's hostname, or name the site in the ${SITE_HEADER} header`,
					400,
				),
			);
		}
		return runAsSiteCheckingAccess(router, site, run);
	}
	if (isControlPlanePath(pathname) && pathname !== HANDOFF_START_PATH) {
		return runAsSite(CONTROL_PLANE_SITE_ID, adminConfig, () => {
			context.locals.emdashMultiSite = { router, config: adminConfig };
			return run(adminConfig);
		});
	}
	return runAsSite(CONTROL_PLANE_SITE_ID, adminConfig, async (controlRuntime) => {
		const sessionUser = await resolveSessionUser(context.session);
		const user = sessionUser ? await findControlPlaneUser(controlRuntime.db, sessionUser.id) : null;
		if (pathname === HANDOFF_START_PATH) {
			if (!user || user.disabled) {
				return finalizeResponse(apiError("NOT_AUTHENTICATED", "Not authenticated", 401));
			}
			return startHandoff(context, router, user);
		}
		if (!user || user.disabled) return run(adminConfig);
		if (user.emailVerified) {
			try {
				await acceptOrgInvites(router.controlPlane, user.id, user.email);
			} catch (error) {
				console.error("[emdash:multisite] accepting organization invitations failed:", error);
			}
		}

		let site: (RequestSite & { role: RoleLevel }) | null;
		try {
			site = await selectAdminSite(context, router, user);
		} catch (error) {
			console.error("[emdash:multisite] selecting the admin site failed:", error);
			return siteUnavailableResponse();
		}
		if (!site) return run(adminConfig);
		if (context.cookies.get(ADMIN_SITE_COOKIE)?.value !== site.siteId) {
			context.cookies.set(ADMIN_SITE_COOKIE, site.siteId, {
				path: "/",
				httpOnly: true,
				sameSite: "lax",
				secure: context.url.protocol === "https:",
			});
		}

		const selected = site;
		return runAsSite(selected.siteId, selected.config, async (siteRuntime) => {
			try {
				await syncSiteUser(siteRuntime.db, user, selected.role);
				await ensureSiteSetUp(siteRuntime.db, selected.name);
			} catch (error) {
				if (error instanceof MultiSiteError && error.code === "ACCOUNT_CONFLICT") {
					return finalizeResponse(
						apiError("ACCOUNT_CONFLICT", "This site has a separate account with your email", 409),
					);
				}
				console.error("[emdash:multisite] preparing the site for the admin failed:", error);
				return siteUnavailableResponse();
			}
			return run(selected.config);
		});
	});
}

/**
 * In a multi-site deployment, run the request as the site its hostname names,
 * or through the shared admin when the hostname is the admin host.
 */
async function routeToSite(
	context: APIContext,
	run: (config: EmDashConfig | null) => Promise<Response>,
): Promise<Response> {
	const config = getConfig();
	if (!config?.multiSite || context.isPrerendered) return run(config);
	if (typeof virtualCreateDialect !== "function") {
		throw new Error("multiSite requires a database adapter");
	}

	const router = getSiteRouter({ ...config, multiSite: config.multiSite }, virtualCreateDialect);
	ensureSiteSweep();
	if (router.adminConfig && normalizeHostname(context.url.hostname) === router.adminHostname) {
		return routeAdminHost(context, router, router.adminConfig, run);
	}

	let site: RequestSite | null;
	try {
		site = await router.resolve(context.url.hostname);
	} catch (error) {
		console.error("[emdash:multisite] resolving the request's site failed:", error);
		return siteUnavailableResponse();
	}
	if (!site) {
		return finalizeResponse(
			new Response("Site not found", { status: 404, headers: SITE_NOT_FOUND_HEADERS }),
		);
	}
	const { pathname } = context.url;
	const adminUrl = config.multiSite.adminUrl;
	if (adminUrl && isAdminHostOnlyPath(pathname)) {
		return finalizeResponse(apiError("NOT_FOUND", "Sign in on the admin host", 404));
	}
	if (adminUrl && pathname.startsWith("/_emdash/admin")) {
		const target = new URL(pathname + context.url.search, adminUrl);
		target.searchParams.set("site", site.siteId);
		return finalizeResponse(Response.redirect(target.href, 302));
	}

	const siteConfig = site.config;
	if (!adminUrl) return runAsSite(site.siteId, siteConfig, () => run(siteConfig));
	if (pathname === HANDOFF_COMPLETE_PATH) {
		const siteId = site.siteId;
		return runAsSite(siteId, siteConfig, (runtime) =>
			completeHandoff(context, router, site, runtime.db),
		);
	}
	return runAsSiteCheckingAccess(router, site, run);
}

/**
 * Account routes a site's own hostname refuses when people sign in on the
 * shared admin host. Signing out and reading the current user stay available
 * for sessions started by a handoff.
 */
function isAdminHostOnlyPath(pathname: string): boolean {
	if (pathname.startsWith("/_emdash/api/setup")) return true;
	if (!pathname.startsWith("/_emdash/api/auth/")) return false;
	const route = pathname.replace(TRAILING_SLASH_RE, "");
	return route !== "/_emdash/api/auth/logout" && route !== "/_emdash/api/auth/me";
}

/**
 * Runs a request as a site, with every signed-in user's role rechecked
 * against the control plane before the request trusts the site's copy of
 * their account.
 */
function runAsSiteCheckingAccess(
	router: SiteRouter,
	site: RequestSite,
	run: (config: EmDashConfig | null) => Promise<Response>,
): Promise<Response> {
	const { siteId, config: siteConfig } = site;
	return runAsSite(siteId, siteConfig, (runtime) => {
		const refreshSiteAccount = (userId: string) =>
			refreshAccountFromControlPlane(
				router.controlPlane,
				router.controlAccounts,
				runtime.db,
				siteId,
				userId,
			).catch((error: unknown) => {
				console.error("[emdash:multisite] rechecking a user's site access failed:", error);
				return null;
			});
		const parent = getRequestContext();
		const ctx = parent
			? { ...parent, refreshSiteAccount }
			: { editMode: false, siteId, db: runtime.db, refreshSiteAccount };
		return runWithContext(ctx, () => run(siteConfig));
	});
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request, locals, cookies } = context;
	const url = context.url;

	// Fast path: routes outside /_emdash/ that plugins inject (e.g.,
	// /.well-known/atproto-client-metadata.json) skip the entire runtime
	// init + middleware chain. External servers fetch these with tight
	// timeouts (~1-2s) so they must respond quickly even on cold starts.
	if (!url.pathname.startsWith("/_emdash") && virtualConfig?.authProviders) {
		const isPluginFastRoute = virtualConfig.authProviders.some(
			(p: { routes?: { pattern?: string }[] }) =>
				p.routes?.some((r: { pattern?: string }) => r.pattern && url.pathname === r.pattern),
		);
		if (isPluginFastRoute) {
			return finalizeResponse(await next());
		}
	}

	// Astro re-enters middleware with the same locals while the original render is
	// still active. Its outer scope owns prefetch, metrics, and connection cleanup.
	if (canReuseAnonymousRender(context)) return next();

	const queryRecorder = isInstrumentationEnabled()
		? createRecorder(url.pathname, request.method, request.headers.get("x-perf-phase") ?? "default")
		: undefined;

	const metrics = createRequestMetrics(performance.now());

	const run = async (config: EmDashConfig | null): Promise<Response> => {
		const migrationMode = config ? resolveConfiguredMigrationMode(config) : "auto";
		const pageSignals = getPublicPageSignals(context);
		const {
			publicPath,
			isEmDashRoute,
			hasEditCookie,
			hasPreviewToken,
			hasSessionCookie,
			playgroundDb,
		} = pageSignals;

		// Read the Astro session user once up-front. Both the anonymous fast path
		// and the full doInit path need this, and the session store is network-backed
		// (KV / Durable Object) so we want to avoid re-fetching on the hot path.
		// Skipped entirely for:
		//   - prerendered requests (no session at build time)
		//   - requests without the configured session cookie (no session to look up)
		// The cookie check matters on Cloudflare Workers, where Astro's session
		// backend is KV: calling session.get() on every anonymous public request
		// turns normal traffic into a flood of KV read misses. See #733.
		const sessionUser =
			context.isPrerendered || !hasSessionCookie ? null : await resolveSessionUser(context.session);

		// The image endpoint EmDash installed reads media bytes from storage and
		// nothing else, so it needs neither the setup probe nor runtime init.
		const imageStorage =
			config && !playgroundDb && isImageEndpointRequest(context)
				? tryGetStorage(config, migrationMode)
				: null;
		if (config && imageStorage) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- partial object; the image endpoint reads only storage, the auth middleware db
			const imageLocals = { storage: imageStorage } as EmDashHandlers;
			locals.emdash = imageLocals;
			return runImageRequest(config, context, imageLocals, !!sessionUser, metrics, next);
		}

		// Credentialed API requests (API tokens `ec_pat_*`, OAuth tokens
		// `ec_oat_*`, and other Bearer credentials) carry no `astro-session`
		// cookie, so `sessionUser` is null for them -- yet they still expect
		// read-your-writes. The auth middleware that resolves the token runs
		// *after* this one, so `locals.user` isn't populated here; detect the
		// credential directly on the request. Request-scoped adapters use this to
		// keep such requests on the primary/uncached connection (not a lagging
		// read replica or the Hyperdrive query cache).
		const hasBearerAuth =
			!context.isPrerendered &&
			(request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
		const isWrite = request.method !== "GET" && request.method !== "HEAD";
		const isAuthenticated = !!sessionUser || hasBearerAuth;
		const endedAuthenticated = () => requestEndedAuthenticated(isAuthenticated, cookies);
		const canUseCachedBinding =
			!isAuthenticated &&
			!isWrite &&
			!playgroundDb &&
			!isEmDashRoute &&
			!hasEditCookie &&
			!hasPreviewToken;

		if (isAnonymousPublicPage(pageSignals, !!sessionUser)) {
			const timings: Array<{ name: string; dur: number; desc?: string }> = [];
			const mwStart = performance.now();

			// On a fresh deployment the database may be completely empty.
			// Public pages call getSiteSettings() / getMenu() via getDb(), which
			// bypasses runtime init and would crash with "no such table: options".
			// Do a one-time lightweight probe using the same getDb() instance the
			// page will use: if the migrations table doesn't exist, no migrations
			// have ever run, and the page may only render once runtime init has
			// migrated the database.
			// Skip the probe when prerendering: the build database is legitimately
			// empty in CI, and a response derived from it would be baked into the
			// static page (session reads are already skipped for prerender above
			// for the same reason).
			// Runtime init starts before the probe so the two round trips overlap.
			// Sub-phase timings are populated only on the cold init. Warm
			// requests hit the cached runtime and leave this empty.
			const initSubTimings: Array<{ name: string; dur: number; desc?: string }> = [];
			const runtimeInitStart = performance.now();
			const runtimeInit = config ? getRuntime(config, migrationMode, initSubTimings) : undefined;
			// Awaited below unless the probe fails; then it settles in the background.
			runtimeInit?.catch(() => {});

			let unmigrated = false;
			let probeFailed = false;
			if (migrationMode === "auto" && !isSetupVerified() && !context.isPrerendered) {
				const t0 = performance.now();
				try {
					const { getDb } = await import("../loader.js");
					const db = await getDb();
					await db.selectFrom("_emdash_migrations").selectAll().limit(1).execute();
					markSetupVerified();
				} catch (error) {
					if (isMissingTableError(error)) {
						unmigrated = true;
					} else {
						// Any other failure (transient D1/replica error, timeout, cold-start
						// race, locked SQLite) must NOT be read as "fresh install". Leave the
						// flag unset so a later request can re-verify, and fall through to
						// render the page normally. Unless a runtime is already running,
						// don't wait for runtime init on this request: it connects to the
						// same database and would make the visitor wait through a second
						// timeout. getRuntime anchors it with after(), so it can still
						// finish for later requests.
						probeFailed = !getRuntimeHolder(currentSiteId()).instance;
						console.error("Setup probe failed (non-fatal):", error);
					}
				}
				timings.push({ name: "setup", dur: performance.now() - t0, desc: "Setup probe" });
			}

			// Wait for the runtime for page:metadata and page:fragments hooks.
			// The runtime is a cached singleton — after the first request,
			// getRuntime() is just a null-check. This enables SEO plugins to
			// contribute meta tags for all visitors, not just logged-in editors,
			// except on a request whose setup probe just failed.
			if (runtimeInit && !probeFailed) {
				try {
					const runtime = await runtimeInit;
					markSetupVerified();
					const handlePublicPluginApiRoute = createPublicPluginApiRouteHandler(runtime);
					const getPublicMediaUrl = providePublicMediaUrl(runtime.storage);
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- partial object; getPageRuntime() only checks for the page-contribution methods
					locals.emdash = {
						handlePublicPluginApiRoute,
						getPublicPluginRouteMeta: (pluginId, path) =>
							getPublicPluginRouteMeta(runtime, pluginId, path),
						collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
						collectPageFragments: runtime.collectPageFragments.bind(runtime),
						getPublicMediaUrl,
						storage: runtime.storage,
					} as EmDashHandlers;
				} catch (error) {
					if (isMigrationRequiredError(error)) {
						return migrationRequiredErrorResponse(error);
					}
					if (migrationMode === "manual" && isMissingTableError(error)) {
						console.error(
							"[emdash] database schema is unavailable in manual migration mode:",
							error,
						);
						return migrationRequiredResponse();
					}
					// Non-fatal — EmDashHead falls back to base SEO contributions —
					// but log it (throttled): a persistently failing init (e.g. a
					// failing migration, #1744) is otherwise invisible on the
					// anonymous path, silently degrading every public page.
					if (Date.now() - lastRuntimeInitErrorLogAt >= RUNTIME_INIT_ERROR_LOG_INTERVAL_MS) {
						lastRuntimeInitErrorLogAt = Date.now();
						console.error("[emdash] runtime init failed (page renders without CMS data):", error);
					}
				}
				timings.push({
					name: "rt",
					dur: performance.now() - runtimeInitStart,
					desc: "Runtime init",
				});
				// Append cold-only sub-phase timings so the breakdown is visible
				// in Server-Timing (rt.db, rt.fts, rt.plugins, rt.site,
				// rt.sandbox, rt.market, rt.hooks, rt.cron).
				for (const sub of initSubTimings) timings.push(sub);
			}
			if (unmigrated && !locals.emdash) {
				return finalizeResponse(unmigratedDatabaseResponse(), timings);
			}

			// Even on the anonymous fast path we ask the adapter for a per-request
			// scoped db. For D1 with read replication this routes anonymous reads
			// to the nearest replica; for other adapters it's a no-op.
			const lastContentWriteAt =
				canUseCachedBinding && config?.database?.needsLastContentWriteAt
					? await getLastContentWriteAt()
					: undefined;
			const anonScoped = createRequestScopedDb({
				config: config?.database?.config,
				isAuthenticated,
				endedAuthenticated,
				isWrite,
				canUseCachedBinding,
				cookies,
				url,
				lastContentWriteAt,
			});
			const runAnon = async () => {
				const t0 = performance.now();
				const renderLocals = locals as RenderLocals;
				const previous = renderLocals[ANONYMOUS_RENDER];
				const scope = getRequestContext();
				renderLocals[ANONYMOUS_RENDER] = {
					method: request.method,
					db: scope?.db,
					metrics: scope?.metrics,
				};
				let response: Response;
				try {
					response = await next();
				} finally {
					if (previous) renderLocals[ANONYMOUS_RENDER] = previous;
					else delete renderLocals[ANONYMOUS_RENDER];
				}
				timings.push({ name: "render", dur: performance.now() - t0, desc: "Page render" });
				timings.push({ name: "mw", dur: performance.now() - mwStart, desc: "Total middleware" });
				pushMetricsTimings(timings, metrics);
				// Server-Timing only sees pre-stream queries; the stream-end
				// wrapper (instrumentation-gated, no-op otherwise) emits the
				// final counters once the body finishes streaming.
				return wrapBodyForStreamMetrics(finalizeResponse(response, timings));
			};
			if (anonScoped) {
				const { deferredTasks, lifecycle } = coordinateScopedDbLifecycle(anonScoped);
				const parent = getRequestContext();
				const ctx = parent
					? { ...parent, db: anonScoped.db, deferredTasks }
					: { editMode: false, db: anonScoped.db, metrics, deferredTasks };
				// Eagerly warm site-global layout data (menus, widget areas,
				// taxonomy terms, settings) concurrently so the layout's
				// per-component reads overlap into ~one wall-clock round trip and
				// hit a warm cache instead of serializing. Four guards:
				//  - request-scoped (remote) backend only -- this branch implies it;
				//    pointless on synchronous local SQLite.
				//  - an adapter that can overlap queries -- without that, Kysely's
				//    connection mutex (D1 sessions without `coalesce`) queues the
				//    prefetch ahead of the page's own first query.
				//  - HTML navigations only -- feeds/sitemaps/JSON don't render the
				//    layout, so prefetching their chrome is pure waste.
				//  - the work starts immediately, then after() keeps both it and the
				//    request-scoped connection alive until the response also finishes.
				// Gate on the CLIENT'S PREFERRED type (leading media range), not a
				// substring -- browser navigations lead with `text/html`, while feed
				// readers lead with `application/rss+xml` etc. and only list
				// `text/html;q=0.8` later, so a substring match would leak onto feeds.
				const acceptsHtml = (request.headers.get("accept") ?? "")
					.split(",", 1)[0]!
					.trim()
					.startsWith("text/html");
				return runWithContext(ctx, async () => {
					if (
						acceptsHtml &&
						anonScoped.db.getExecutor().adapter.supportsMultipleConnections !== false
					) {
						after(() => prefetchLayoutData(context.currentLocale));
					}
					// commit() persists per-request state (e.g. the D1 bookmark cookie)
					// before the response is returned, even if render throws; close()
					// waits for stream-end and request-owned deferred work. See finishScoped.
					return finishScoped(lifecycle, runAnon);
				});
			}
			return runAnon();
		}

		if (!config) {
			console.error("EmDash: No configuration found");
			return finalizeResponse(await next());
		}

		// In playground mode, wrap the entire runtime init + request handling in
		// runWithContext so that getDatabase() and all init queries use the real
		// DO database via the same AsyncLocalStorage instance as the loader.
		const doInit = async () => {
			let refreshPluginRoutes: (() => Promise<void>) | undefined;
			const timings: Array<{ name: string; dur: number; desc?: string }> = [];
			const mwStart = performance.now();

			try {
				// Get or create runtime. Sub-phase timings (rt.db, rt.fts, rt.plugins,
				// rt.site, rt.sandbox, rt.market, rt.hooks, rt.cron) are populated
				// only on the cold init — subsequent warm calls find the cached
				// instance and `initSubTimings` stays empty.
				const initSubTimings: Array<{ name: string; dur: number; desc?: string }> = [];
				let t0 = performance.now();
				const runtime = await getRuntime(config, migrationMode, initSubTimings);
				const installedPluginId = publicPath.startsWith("/_emdash/api/plugins/")
					? publicPath.slice("/_emdash/api/plugins/".length).split("/")[0]
					: undefined;
				if (installedPluginId && runtime.mayNeedInstalledPluginRefresh(installedPluginId)) {
					refreshPluginRoutes = () => runtime.refreshInstalledPluginRoute(installedPluginId);
				}
				timings.push({ name: "rt", dur: performance.now() - t0, desc: "Runtime init" });
				// Forward any sub-phase samples so cold-start breakdown is visible
				// in Server-Timing. Each phase appears prefixed "rt." to distinguish
				// from the aggregate "rt" timing above.
				for (const sub of initSubTimings) timings.push(sub);

				// Runtime initialization has satisfied the effective migration policy.
				markSetupVerified();

				// The manifest is no longer pre-loaded here. It's admin-only
				// content that public/anonymous requests never read, and
				// loading it on every request put logged-out hot paths on
				// the same staleness budget as admin operations. Admin
				// routes call `emdash.getManifest()` directly.

				// Attach to locals for route handlers
				locals.emdash = {
					// Content handlers
					handleContentList: runtime.handleContentList.bind(runtime),
					handleContentGet: runtime.handleContentGet.bind(runtime),
					handleContentAuthors: runtime.handleContentAuthors.bind(runtime),
					handleContentCreate: runtime.handleContentCreate.bind(runtime),
					handleContentUpdate: runtime.handleContentUpdate.bind(runtime),
					handleContentDelete: runtime.handleContentDelete.bind(runtime),

					// Trash handlers
					handleContentListTrashed: runtime.handleContentListTrashed.bind(runtime),
					handleContentRestore: runtime.handleContentRestore.bind(runtime),
					handleContentPermanentDelete: runtime.handleContentPermanentDelete.bind(runtime),
					handleContentCountTrashed: runtime.handleContentCountTrashed.bind(runtime),
					handleContentGetIncludingTrashed: runtime.handleContentGetIncludingTrashed.bind(runtime),

					// Duplicate handler
					handleContentDuplicate: runtime.handleContentDuplicate.bind(runtime),

					// Publishing & Scheduling handlers
					handleContentPublish: runtime.handleContentPublish.bind(runtime),
					handleContentUnpublish: runtime.handleContentUnpublish.bind(runtime),
					handleContentSchedule: runtime.handleContentSchedule.bind(runtime),
					handleContentUnschedule: runtime.handleContentUnschedule.bind(runtime),
					handleContentCountScheduled: runtime.handleContentCountScheduled.bind(runtime),
					handleContentDiscardDraft: runtime.handleContentDiscardDraft.bind(runtime),
					handleContentCompare: runtime.handleContentCompare.bind(runtime),
					handleContentTranslations: runtime.handleContentTranslations.bind(runtime),

					// Media handlers
					handleMediaList: runtime.handleMediaList.bind(runtime),
					handleMediaGet: runtime.handleMediaGet.bind(runtime),
					handleMediaUpload: runtime.handleMediaUpload.bind(runtime),
					handleMediaCreate: runtime.handleMediaCreate.bind(runtime),
					handleMediaRegisterUpload: runtime.handleMediaRegisterUpload.bind(runtime),
					handleMediaUpdate: runtime.handleMediaUpdate.bind(runtime),
					...(runtime.handleMediaReplaceMetadata
						? {
								handleMediaReplaceMetadata: runtime.handleMediaReplaceMetadata.bind(runtime),
							}
						: {}),
					handleMediaDelete: runtime.handleMediaDelete.bind(runtime),

					// Comment administration
					...(runtime.handleCommentModerate
						? { handleCommentModerate: runtime.handleCommentModerate.bind(runtime) }
						: {}),

					// Revision handlers
					handleRevisionList: runtime.handleRevisionList.bind(runtime),
					handleRevisionEditors: runtime.handleRevisionEditors.bind(runtime),
					handleRevisionGet: runtime.handleRevisionGet.bind(runtime),
					handleRevisionRestore: runtime.handleRevisionRestore.bind(runtime),

					// Plugin routes
					handlePluginApiRoute: runtime.handlePluginApiRoute.bind(runtime),
					getPluginEditorExtension: runtime.getPluginEditorExtension.bind(runtime),
					getPluginEditorDraftSchema: runtime.getPluginEditorDraftSchema.bind(runtime),
					handlePublicPluginApiRoute: createPublicPluginApiRouteHandler(runtime),
					getPublicPluginRouteMeta: (pluginId, path) =>
						getPublicPluginRouteMeta(runtime, pluginId, path),
					getPluginRouteMeta: runtime.getPluginRouteMeta.bind(runtime),
					getPluginMcpTools: runtime.getPluginMcpTools.bind(runtime),
					getEnabledPluginMcpTools: runtime.getEnabledPluginMcpTools.bind(runtime),
					serializePluginMcpConsent: runtime.serializePluginMcpConsent.bind(runtime),
					handlePluginMcpTool: runtime.handlePluginMcpTool.bind(runtime),
					handlePluginMcpDenied: runtime.handlePluginMcpDenied.bind(runtime),

					// Media provider methods
					getMediaProvider: runtime.getMediaProvider.bind(runtime),
					getMediaProviderList: runtime.getMediaProviderList.bind(runtime),

					// Page contribution methods (for EmDashHead/EmDashBodyStart/EmDashBodyEnd)
					collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
					collectPageFragments: runtime.collectPageFragments.bind(runtime),

					// Lazy search index health check — search endpoints call this
					// before querying so a crash-corrupted index gets repaired on
					// first use rather than stalling every cold start.
					ensureSearchHealthy: runtime.ensureSearchHealthy.bind(runtime),

					// Direct access (for advanced use cases)
					storage: runtime.storage,
					// Lazy getter, not an eager snapshot: `locals.emdash` is built
					// before the per-request scoped db is installed in ALS, so reading
					// `runtime.db` here would capture the per-isolate singleton. Routes
					// access `emdash.db` later, during the request, when the scoped db
					// is active. For a stateless binding (D1) the two are equivalent,
					// but for a request-bound connection (pg/Hyperdrive) the singleton
					// belongs to the cold-start request and reusing it from a warm
					// request hangs on workerd's cross-request I/O guard.
					get db() {
						return runtime.db;
					},
					getPublicMediaUrl: providePublicMediaUrl(runtime.storage),
					hooks: runtime.hooks,
					email: runtime.email,
					configuredPlugins: runtime.configuredPlugins,
					sandboxedPluginEntries: runtime.sandboxedPluginEntries,

					// Configuration (for checking database type, auth mode, etc.)
					config,

					// Lazy manifest accessor — admin-only consumers call this on
					// demand. `requestCached` inside `getManifest` dedupes within
					// a single request.
					getManifest: runtime.getManifest.bind(runtime),

					// Co-editing rooms, or null when this host can't run them
					rooms: runtime.rooms,

					// Clear the URL pattern cache after schema mutations that
					// affect collection URL patterns.
					invalidateUrlPatternCache,

					// Sandbox runner (for marketplace plugin install/update)
					getSandboxRunner: runtime.getSandboxRunner.bind(runtime),
					isSandboxBypassed: runtime.isSandboxBypassed.bind(runtime),

					// Sync marketplace plugin states (after install/update/uninstall)
					syncMarketplacePlugins: runtime.syncMarketplacePlugins.bind(runtime),

					// Sync registry plugin states (after install/update/uninstall)
					syncRegistryPlugins: runtime.syncRegistryPlugins.bind(runtime),
					runPluginInstallLifecycle: runtime.runPluginInstallLifecycle.bind(runtime),
					runPluginActivateLifecycle: runtime.runPluginActivateLifecycle.bind(runtime),
					runPluginUninstallLifecycle: runtime.runPluginUninstallLifecycle.bind(runtime),
					getRuntimePluginSettingsSchema: runtime.getRuntimePluginSettingsSchema.bind(runtime),

					// Update plugin enabled/disabled status and rebuild hook pipeline
					setPluginStatus: runtime.setPluginStatus.bind(runtime),
				};
			} catch (error) {
				if (isMigrationRequiredError(error)) {
					return migrationRequiredErrorResponse(error);
				}
				if (migrationMode === "manual" && isMissingTableError(error)) {
					console.error("[emdash] database schema is unavailable in manual migration mode:", error);
					return migrationRequiredResponse();
				}
				console.error("EmDash middleware error:", error);
				const configurationError = runtimeConfigurationErrorResponse(error, url.pathname);
				if (configurationError) return configurationError;
			}

			// Ask the adapter for a request-scoped db. When it returns one, we stash
			// it in ALS so the runtime's db getter and loader's getDb() pick it up,
			// then call commit() after next() so the adapter can persist any
			// per-request state (e.g. a D1 bookmark cookie for read-your-writes).
			const lastContentWriteAt =
				canUseCachedBinding && config?.database?.needsLastContentWriteAt
					? await getLastContentWriteAt()
					: undefined;
			const scoped = createRequestScopedDb({
				config: config?.database?.config,
				isAuthenticated,
				endedAuthenticated,
				isWrite,
				canUseCachedBinding,
				cookies: context.cookies,
				url,
				lastContentWriteAt,
			});

			const renderAndFinalize = async () => {
				// Warm isolates do not observe installs handled by another isolate.
				// Refresh before downstream auth reads plugin route metadata, using
				// the request-scoped database when the adapter provides one.
				if (refreshPluginRoutes && publicPath.startsWith("/_emdash/api/plugins/")) {
					try {
						await refreshPluginRoutes();
					} catch (error) {
						console.error("EmDash: Failed to refresh installed plugin routes:", error);
						return finalizeResponse(
							apiError("PLUGIN_SYNC_ERROR", "Plugin routes are temporarily unavailable", 503),
						);
					}
				}
				const t0 = performance.now();
				const response = await next();
				timings.push({ name: "render", dur: performance.now() - t0, desc: "Page render" });
				timings.push({ name: "mw", dur: performance.now() - mwStart, desc: "Total middleware" });
				pushMetricsTimings(timings, metrics);
				// Server-Timing only sees pre-stream queries; the stream-end
				// wrapper (instrumentation-gated, no-op otherwise) emits the
				// final counters once the body finishes streaming.
				return wrapBodyForStreamMetrics(finalizeResponse(response, timings));
			};

			if (scoped) {
				const { deferredTasks, lifecycle } = coordinateScopedDbLifecycle(scoped);
				const parent = getRequestContext();
				const ctx = parent
					? { ...parent, db: scoped.db, deferredTasks }
					: { editMode: false, db: scoped.db, metrics, deferredTasks };
				return runWithContext(ctx, () =>
					// commit() persists per-request state (e.g. the D1 bookmark cookie)
					// before the response returns, even if render throws; close()
					// waits for stream-end and request-owned deferred work. See finishScoped.
					finishScoped(lifecycle, renderAndFinalize),
				);
			}

			return renderAndFinalize();
		}; // end doInit

		if (playgroundDb) {
			// Read the edit-mode cookie to determine if visual editing is active.
			// Default to false -- editing is opt-in via the playground toolbar toggle.
			const editMode = context.cookies.get("emdash-edit-mode")?.value === "true";
			// Playground DBs are per-session isolated instances whose schema is
			// independent of the configured one — flag as isolated so schema-
			// derived caches (manifest, taxonomy defs) rebuild against it.
			const parent = getRequestContext();
			const ctx = parent
				? { ...parent, editMode, db: playgroundDb, dbIsIsolated: true }
				: { editMode, db: playgroundDb, dbIsIsolated: true, metrics };
			return runWithContext(ctx, doInit);
		}
		return doInit();
	};

	try {
		const response = await runWithContext({ editMode: false, queryRecorder, metrics }, () =>
			routeToSite(context, run),
		);
		applyBuildValidator(context);
		keepUnsharedResponsesOutOfRouteCache(context, response);
		return response;
	} finally {
		// Streamed responses defer the flush to stream end (see
		// wrapBodyForStreamMetrics) so the log captures queries issued while
		// the body renders. Only flush here for responses that were not
		// wrapped (no body: redirects, 304s, bodyless errors), where all
		// queries have already run by the time middleware returns.
		if (queryRecorder && !queryRecorder.deferredFlush) flushRecorder(queryRecorder);
	}
});

export default onRequest;
