import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const {
	VIRTUAL_CONFIG,
	mockRuntimeCreate,
	mockGetDb,
	router,
	identity,
	handoff,
	mockStartSession,
	mockAcceptInvites,
	mockListSites,
	mockReleaseSite,
} = vi.hoisted(() => ({
	VIRTUAL_CONFIG: {
		database: { entrypoint: "test", config: { url: "default" }, type: "sqlite" },
		migrations: { runtime: "check", dev: "check" },
		multiSite: {
			controlPlane: { url: "control" },
			databases: { "brand-a": { url: "brand-a" }, "brand-b": { url: "brand-b" } },
		} as Record<string, unknown>,
	},
	mockRuntimeCreate: vi.fn(),
	mockGetDb: vi.fn(),
	router: {
		controlPlane: { name: "control-plane" },
		adminConfig: null as Record<string, unknown> | null,
		adminHostname: null as string | null,
		resolve: vi.fn(),
		siteById: vi.fn(),
		activeSites: vi.fn(),
	},
	identity: {
		findControlPlaneUser: vi.fn(),
		siteRoleFor: vi.fn(),
		syncSiteUser: vi.fn(),
		ensureSiteSetUp: vi.fn(),
		refreshSiteAccount: vi.fn(),
	},
	handoff: { createHandoff: vi.fn(), consumeHandoff: vi.fn() },
	mockStartSession: vi.fn(),
	mockAcceptInvites: vi.fn(),
	mockListSites: vi.fn(),
	mockReleaseSite: vi.fn(),
}));

vi.mock("virtual:emdash/config", () => ({ default: VIRTUAL_CONFIG }), { virtual: true });
vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createCoalescingDialect: undefined,
		createRequestScopedDb: vi.fn().mockReturnValue(null),
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({ createSandboxRunner: null, sandboxBypassed: false, sandboxEnabled: false }),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("virtual:emdash/scheduler", () => ({ createScheduler: null }), { virtual: true });

vi.mock("../../../src/emdash-runtime.js", () => ({
	DB_INIT_DEADLINE_MS: 30_000,
	EmDashRuntime: { create: mockRuntimeCreate, releaseSite: mockReleaseSite },
}));
vi.mock("../../../src/loader.js", () => ({ getDb: mockGetDb }));
vi.mock("../../../src/astro/middleware/site.js", () => ({
	CONTROL_PLANE_SITE_ID: "control-plane",
	getSiteRouter: () => router,
}));
vi.mock("../../../src/multisite/identity.js", () => identity);
vi.mock("../../../src/multisite/repository.js", () => ({
	listSitesForUser: mockListSites,
	acceptOrgInvites: mockAcceptInvites,
}));
vi.mock("../../../src/multisite/handoff.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/multisite/handoff.js")>()),
	...handoff,
}));
vi.mock("../../../src/auth/start-user-session.js", () => ({ startUserSession: mockStartSession }));

import onRequest, { runScheduledTasks } from "../../../src/astro/middleware.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { MultiSiteError } from "../../../src/multisite/errors.js";
import { getRequestContext } from "../../../src/request-context.js";

const store = globalThis as Record<symbol, unknown>;

function contextFor(
	url: string,
	options: {
		userId?: string;
		cookies?: Record<string, string>;
		method?: string;
		headers?: Record<string, string>;
		body?: BodyInit;
	} = {},
) {
	const parsed = new URL(url);
	const jar = new Map(Object.entries(options.cookies ?? {}));
	return {
		request: new Request(parsed, {
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
		}),
		url: parsed,
		cookies: {
			get: vi.fn((name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined)),
			set: vi.fn((name: string, value: string) => jar.set(name, value)),
			headers: () => [],
		},
		jar,
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: {
			get: vi.fn(async () => (options.userId ? { id: options.userId } : undefined)),
		},
	};
}

function fakeRuntime(name: string) {
	return {
		name,
		db: { name: `${name}-db` },
		storage: null,
		collectPageMetadata: vi.fn(async () => []),
		collectPageFragments: vi.fn(async () => []),
		rooms: null,
		shutdown: vi.fn(async () => {}),
		runScheduledTasks: vi.fn(async () => ({ published: [{ collection: "posts", id: name }] })),
	};
}

function siteFor(siteId: string, url: string) {
	return {
		siteId,
		orgId: "org-1",
		name: `Site ${siteId}`,
		config: { ...VIRTUAL_CONFIG, database: { ...VIRTUAL_CONFIG.database, config: { url } } },
	};
}

describe("multi-site request routing", () => {
	beforeEach(() => {
		delete store[Symbol.for("emdash:runtime-holder")];
		delete store[Symbol.for("emdash:runtime-holder@sites")];
		mockGetDb.mockReset();
		router.resolve.mockReset();
		router.siteById.mockReset();
		router.activeSites.mockReset().mockResolvedValue([]);
		router.adminConfig = null;
		router.adminHostname = null;
		delete VIRTUAL_CONFIG.multiSite.adminUrl;
		for (const fn of Object.values(identity)) fn.mockReset();
		mockListSites.mockReset().mockResolvedValue([]);
		mockRuntimeCreate.mockReset();
		mockRuntimeCreate.mockImplementation(async (deps: { siteId?: string }) =>
			fakeRuntime(deps.siteId ?? "default"),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("returns 404 for a hostname no site lists, without opening any site", async () => {
		router.resolve.mockResolvedValue(null);
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(contextFor("https://unknown.example/") as never, next);

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(next).not.toHaveBeenCalled();
		expect(mockRuntimeCreate).not.toHaveBeenCalled();
		expect(mockGetDb).not.toHaveBeenCalled();
	});

	it("generates types from the default database when the dev server asks on its own address", async () => {
		router.resolve.mockResolvedValue(null);
		const next = vi.fn(async () => new Response("types"));

		const response = await onRequest(
			contextFor("http://127.0.0.1:4321/_emdash/api/typegen", { method: "POST" }) as never,
			next,
		);

		expect(response.status).not.toBe(404);
		expect(
			mockRuntimeCreate.mock.calls.map(([deps]) => (deps as { siteId?: string }).siteId),
		).toEqual([undefined]);
	});

	it("renders a site's page on that site's runtime and database", async () => {
		router.resolve.mockImplementation(async (hostname: string) =>
			hostname === "brand-a.com" ? siteFor("site-a", "brand-a") : siteFor("site-b", "brand-b"),
		);
		const seen: unknown[] = [];
		const next = vi.fn(async () => {
			const ctx = getRequestContext();
			seen.push({ siteId: ctx?.siteId, db: ctx?.db });
			return new Response("page");
		});

		await onRequest(contextFor("https://brand-a.com/") as never, next);
		await onRequest(contextFor("https://brand-b.com/") as never, next);
		await onRequest(contextFor("https://brand-a.com/about") as never, next);

		expect(seen).toEqual([
			{ siteId: "site-a", db: { name: "site-a-db" } },
			{ siteId: "site-b", db: { name: "site-b-db" } },
			{ siteId: "site-a", db: { name: "site-a-db" } },
		]);
		expect(mockRuntimeCreate).toHaveBeenCalledTimes(2);
		const [[depsA], [depsB]] = mockRuntimeCreate.mock.calls as [
			[{ siteId: string; config: { database: { config: unknown } } }],
			[{ siteId: string; config: { database: { config: unknown } } }],
		];
		expect([depsA.siteId, depsA.config.database.config]).toEqual(["site-a", { url: "brand-a" }]);
		expect([depsB.siteId, depsB.config.database.config]).toEqual(["site-b", { url: "brand-b" }]);
		expect(mockGetDb).not.toHaveBeenCalled();
	});

	it("returns 503 instead of falling back to the default database when a site fails to start", async () => {
		router.resolve.mockResolvedValue(siteFor("site-a", "brand-a"));
		mockRuntimeCreate.mockRejectedValue(new Error("connection reset"));
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(contextFor("https://brand-a.com/") as never, next);

		expect(response.status).toBe(503);
		expect(next).not.toHaveBeenCalled();
		expect(mockGetDb).not.toHaveBeenCalled();
	});

	it("returns 503 when the control plane cannot be read", async () => {
		router.resolve.mockRejectedValue(new Error("control plane offline"));
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(contextFor("https://brand-a.com/") as never, next);

		expect(response.status).toBe(503);
		expect(next).not.toHaveBeenCalled();
	});
});

describe("shared admin host", () => {
	const adminConfig = { ...VIRTUAL_CONFIG, siteUrl: "https://admin.example.com" };
	const ravi = { id: "user-ravi", email: "ravi@example.com", role: 10, disabled: false };

	function seen() {
		const contexts: Array<{ siteId?: string; db?: unknown }> = [];
		const next = vi.fn(async () => {
			const ctx = getRequestContext();
			contexts.push({ siteId: ctx?.siteId, db: ctx?.db });
			return new Response("page");
		});
		return { contexts, next };
	}

	beforeEach(() => {
		delete store[Symbol.for("emdash:runtime-holder")];
		delete store[Symbol.for("emdash:runtime-holder@sites")];
		mockGetDb.mockReset();
		mockRuntimeCreate.mockReset();
		mockRuntimeCreate.mockImplementation(async (deps: { siteId?: string }) =>
			fakeRuntime(deps.siteId ?? "default"),
		);
		VIRTUAL_CONFIG.multiSite.adminUrl = "https://admin.example.com";
		router.adminConfig = adminConfig;
		router.adminHostname = "admin.example.com";
		router.resolve.mockReset();
		router.siteById
			.mockReset()
			.mockImplementation(async (id: string) =>
				id === "site-a" || id === "site-b" ? siteFor(id, id.replace("site", "brand")) : null,
			);
		router.activeSites.mockReset().mockResolvedValue([]);
		for (const fn of Object.values(identity)) fn.mockReset();
		for (const fn of Object.values(handoff)) fn.mockReset();
		mockStartSession.mockReset();
		mockAcceptInvites.mockReset().mockResolvedValue(0);
		identity.findControlPlaneUser.mockResolvedValue(ravi);
		identity.siteRoleFor.mockImplementation(async (_cp: unknown, _user: unknown, id: string) =>
			id === "site-b" ? 40 : null,
		);
		mockListSites.mockReset().mockResolvedValue([{ id: "site-b" }]);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("runs sign-in on the control plane", async () => {
		const { contexts, next } = seen();
		const ctx = contextFor("https://admin.example.com/_emdash/api/auth/passkey/options", {
			userId: ravi.id,
		});

		await onRequest(ctx as never, next);

		expect(contexts).toEqual([{ siteId: "control-plane", db: { name: "control-plane-db" } }]);
		expect(identity.syncSiteUser).not.toHaveBeenCalled();
	});

	it("shows the control plane's admin to a visitor who is not signed in", async () => {
		const { contexts, next } = seen();
		await onRequest(contextFor("https://admin.example.com/_emdash/admin") as never, next);
		expect(contexts.map((c) => c.siteId)).toEqual(["control-plane"]);
	});

	it("runs a signed-in user's admin request as the requested site with their site role", async () => {
		const { contexts, next } = seen();
		const ctx = contextFor("https://admin.example.com/_emdash/admin?site=site-b", {
			userId: ravi.id,
		});

		await onRequest(ctx as never, next);

		expect(contexts).toEqual([{ siteId: "site-b", db: { name: "site-b-db" } }]);
		expect(identity.syncSiteUser).toHaveBeenCalledWith({ name: "site-b-db" }, ravi, 40);
		expect(identity.ensureSiteSetUp).toHaveBeenCalledWith({ name: "site-b-db" }, "Site site-b");
		expect(ctx.jar.get("emdash-site")).toBe("site-b");
	});

	it("ignores a remembered site the user can no longer reach", async () => {
		const { contexts, next } = seen();
		const ctx = contextFor("https://admin.example.com/_emdash/api/content/posts", {
			userId: ravi.id,
			cookies: { "emdash-site": "site-a" },
		});

		await onRequest(ctx as never, next);

		expect(contexts.map((c) => c.siteId)).toEqual(["site-b"]);
		expect(identity.syncSiteUser.mock.calls).toEqual([[{ name: "site-b-db" }, ravi, 40]]);
		expect(ctx.jar.get("emdash-site")).toBe("site-b");
	});

	it("reports an account conflict instead of merging with a separate site account", async () => {
		identity.syncSiteUser.mockRejectedValue(new MultiSiteError("ACCOUNT_CONFLICT", "conflict"));
		const { next } = seen();

		const response = await onRequest(
			contextFor("https://admin.example.com/_emdash/admin?site=site-b", {
				userId: ravi.id,
			}) as never,
			next,
		);

		expect(response.status).toBe(409);
		expect(next).not.toHaveBeenCalled();
	});

	it("sends a site's own admin URL to the shared admin with that site selected", async () => {
		router.resolve.mockResolvedValue(siteFor("site-a", "brand-a"));
		const { next } = seen();

		const response = await onRequest(
			contextFor("https://brand-a.com/_emdash/admin/content") as never,
			next,
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"https://admin.example.com/_emdash/admin/content?site=site-a",
		);
		expect(next).not.toHaveBeenCalled();
	});

	it.each(["/_emdash/api/setup/admin", "/_emdash/api/auth/magic-link/send"])(
		"refuses %s on a site hostname so accounts can only be created on the admin host",
		async (path) => {
			router.resolve.mockResolvedValue(siteFor("site-a", "brand-a"));
			const { next } = seen();

			const response = await onRequest(contextFor(`https://brand-a.com${path}`) as never, next);

			expect(response.status).toBe(404);
			expect(next).not.toHaveBeenCalled();
			expect(mockRuntimeCreate).not.toHaveBeenCalled();
		},
	);

	it("runs an API token request on the admin host as the site the header names", async () => {
		identity.refreshSiteAccount.mockResolvedValue(40);
		const { contexts, next } = seen();
		const ctx = contextFor("https://admin.example.com/_emdash/api/content/posts", {
			headers: { Authorization: "Bearer ec_pat_x", "X-EmDash-Site": "site-b" },
		});

		await onRequest(ctx as never, next);

		expect(contexts).toEqual([{ siteId: "site-b", db: { name: "site-b-db" } }]);
	});

	it("asks an API token request on the admin host to name its site", async () => {
		const { next } = seen();
		const response = await onRequest(
			contextFor("https://admin.example.com/_emdash/api/content/posts", {
				headers: { Authorization: "Bearer ec_pat_x" },
			}) as never,
			next,
		);

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"SITE_REQUIRED",
		);
		expect(next).not.toHaveBeenCalled();
	});

	it("issues a sign-in link for a site the user can reach", async () => {
		handoff.createHandoff.mockResolvedValue("tok");
		router.siteById.mockImplementation(async (id: string) =>
			id === "site-b"
				? {
						...siteFor("site-b", "brand-b"),
						config: { ...VIRTUAL_CONFIG, siteUrl: "https://brand-b.com" },
					}
				: null,
		);
		const response = await onRequest(
			contextFor(
				"https://admin.example.com/_emdash/api/multisite/handoff?site=site-b&redirect=/blog",
				{
					userId: ravi.id,
					method: "POST",
					headers: { "X-EmDash-Request": "1" },
				},
			) as never,
			vi.fn(),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(((await response.json()) as { data: { url: string } }).data.url).toBe(
			"https://brand-b.com/_emdash/api/multisite/handoff/complete?token=tok&redirect=%2Fblog",
		);
	});

	it.each([
		["a GET", { method: "GET", headers: {} }],
		["a POST without the request header", { method: "POST", headers: {} }],
	])("refuses to issue a sign-in link from %s", async (_label, request) => {
		const response = await onRequest(
			contextFor("https://admin.example.com/_emdash/api/multisite/handoff?site=site-b", {
				userId: ravi.id,
				...request,
			}) as never,
			vi.fn(),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(handoff.createHandoff).not.toHaveBeenCalled();
	});

	it("asks before redeeming a sign-in link on the site", async () => {
		router.resolve.mockResolvedValue({
			...siteFor("site-b", "brand-b"),
			config: { ...VIRTUAL_CONFIG, siteUrl: "https://brand-b.com" },
		});
		const response = await onRequest(
			contextFor(
				"https://brand-b.com/_emdash/api/multisite/handoff/complete?token=tok&redirect=/blog",
			) as never,
			vi.fn(),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('name="token" value="tok"');
		expect(handoff.consumeHandoff).not.toHaveBeenCalled();
	});

	it("starts the site's session when the site's own page continues", async () => {
		router.resolve.mockResolvedValue({
			...siteFor("site-b", "brand-b"),
			config: { ...VIRTUAL_CONFIG, siteUrl: "https://brand-b.com" },
		});
		handoff.consumeHandoff.mockResolvedValue(ravi.id);
		identity.refreshSiteAccount.mockResolvedValue(40);
		const ctx = contextFor("https://brand-b.com/_emdash/api/multisite/handoff/complete", {
			method: "POST",
			headers: { Origin: "https://brand-b.com" },
			body: new URLSearchParams({ token: "tok", redirect: "/blog" }),
		});

		const response = await onRequest(ctx as never, vi.fn());

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe("/blog");
		expect(handoff.consumeHandoff).toHaveBeenCalledWith(router.controlPlane, "tok", "site-b");
		expect(mockStartSession).toHaveBeenCalledWith({ name: "site-b-db" }, ctx.session, ravi.id);
	});

	it("refuses a sign-in posted from another website", async () => {
		router.resolve.mockResolvedValue({
			...siteFor("site-b", "brand-b"),
			config: { ...VIRTUAL_CONFIG, siteUrl: "https://brand-b.com" },
		});
		const response = await onRequest(
			contextFor("https://brand-b.com/_emdash/api/multisite/handoff/complete", {
				method: "POST",
				headers: { Origin: "https://evil.example" },
				body: new URLSearchParams({ token: "tok" }),
			}) as never,
			vi.fn(),
		);

		expect(response.status).toBe(403);
		expect(handoff.consumeHandoff).not.toHaveBeenCalled();
		expect(mockStartSession).not.toHaveBeenCalled();
	});

	it.each([
		["the admin host", "https://admin.example.com/_emdash/api/admin/users/u-ravi"],
		["a site hostname", "https://brand-b.com/_emdash/api/admin/users/u-ravi"],
	])("refuses changes to a site's own accounts on %s", async (_label, url) => {
		router.resolve.mockResolvedValue(siteFor("site-b", "brand-b"));
		identity.refreshSiteAccount.mockResolvedValue(50);
		const { next } = seen();

		const response = await onRequest(
			contextFor(url, {
				userId: ravi.id,
				method: "PATCH",
				headers: { "X-EmDash-Request": "1" },
				cookies: { "emdash-site": "site-b" },
			}) as never,
			next,
		);

		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"USERS_MANAGED_BY_ORGANIZATION",
		);
		expect(next).not.toHaveBeenCalled();
	});

	it("still lists a site's accounts on the admin host", async () => {
		const { contexts, next } = seen();
		await onRequest(
			contextFor("https://admin.example.com/_emdash/api/admin/users", {
				userId: ravi.id,
				cookies: { "emdash-site": "site-b" },
			}) as never,
			next,
		);
		expect(contexts.map((c) => c.siteId)).toEqual(["site-b"]);
	});

	it("keeps sign-out available on a site hostname", async () => {
		router.resolve.mockResolvedValue(siteFor("site-a", "brand-a"));
		const { next } = seen();
		await onRequest(
			contextFor("https://brand-a.com/_emdash/api/auth/logout", { method: "POST" }) as never,
			next,
		);
		expect(next).toHaveBeenCalled();
	});

	it("turns pending organization invitations into memberships when a verified user signs in", async () => {
		identity.findControlPlaneUser.mockResolvedValue({ ...ravi, emailVerified: true });
		const { next } = seen();
		await onRequest(
			contextFor("https://admin.example.com/_emdash/admin", { userId: ravi.id }) as never,
			next,
		);
		expect(mockAcceptInvites).toHaveBeenCalledWith(router.controlPlane, ravi.id, ravi.email);
	});
});

describe("site lifecycle", () => {
	beforeEach(() => {
		delete store[Symbol.for("emdash:runtime-holder")];
		delete store[Symbol.for("emdash:runtime-holder@sites")];
		delete store[Symbol.for("emdash:multi-site-activity")];
		mockRuntimeCreate.mockReset();
		mockRuntimeCreate.mockImplementation(async (deps: { siteId?: string }) =>
			fakeRuntime(deps.siteId ?? "default"),
		);
		mockReleaseSite.mockReset();
		router.adminConfig = null;
		router.adminHostname = null;
		delete VIRTUAL_CONFIG.multiSite.adminUrl;
		router.resolve
			.mockReset()
			.mockImplementation(async (hostname: string) =>
				hostname === "brand-a.com" ? siteFor("site-a", "brand-a") : siteFor("site-b", "brand-b"),
			);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		delete VIRTUAL_CONFIG.multiSite.idleSiteTtlMs;
		vi.restoreAllMocks();
	});

	it("releases a site that has been idle past the TTL and reopens it on the next request", async () => {
		VIRTUAL_CONFIG.multiSite.idleSiteTtlMs = 5 * 60_000;
		const start = Date.UTC(2026, 0, 1);
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		const page = () => vi.fn(async () => new Response("page"));

		await onRequest(contextFor("https://brand-a.com/") as never, page());
		const siteA = await mockRuntimeCreate.mock.results[0]!.value;

		now.mockReturnValue(start + 2 * 60_000);
		await onRequest(contextFor("https://brand-b.com/") as never, page());
		await waitForDeferredTasks();
		expect(siteA.shutdown).not.toHaveBeenCalled();

		now.mockReturnValue(start + 6 * 60_000);
		await onRequest(contextFor("https://brand-b.com/") as never, page());
		await waitForDeferredTasks();
		expect(siteA.shutdown).toHaveBeenCalledTimes(1);
		expect(mockReleaseSite.mock.calls).toEqual([["site-a"]]);

		await onRequest(contextFor("https://brand-a.com/") as never, page());
		expect(
			mockRuntimeCreate.mock.calls.map(([deps]) => (deps as { siteId: string }).siteId),
		).toEqual(["site-a", "site-b", "site-a"]);
	});

	it("keeps every site loaded when the idle TTL is 0", async () => {
		VIRTUAL_CONFIG.multiSite.idleSiteTtlMs = 0;
		const start = Date.UTC(2026, 0, 1);
		const now = vi.spyOn(Date, "now").mockReturnValue(start);
		await onRequest(
			contextFor("https://brand-a.com/") as never,
			vi.fn(async () => new Response()),
		);
		now.mockReturnValue(start + 24 * 60 * 60_000);
		await onRequest(
			contextFor("https://brand-b.com/") as never,
			vi.fn(async () => new Response()),
		);
		await waitForDeferredTasks();

		expect(mockReleaseSite).not.toHaveBeenCalled();
	});

	it("runs scheduled tasks for the control plane and every active site", async () => {
		router.adminConfig = { ...VIRTUAL_CONFIG, siteUrl: "https://admin.example.com" };
		router.activeSites.mockResolvedValue([
			siteFor("site-a", "brand-a"),
			siteFor("site-b", "brand-b"),
		]);

		const result = await runScheduledTasks();

		expect(
			mockRuntimeCreate.mock.calls.map(([deps]) => (deps as { siteId: string }).siteId),
		).toEqual(["control-plane", "site-a", "site-b"]);
		for (const [deps] of mockRuntimeCreate.mock.calls) {
			expect((deps as { createScheduler: unknown }).createScheduler).toBeNull();
		}
		expect(result.published.map((ref) => ref.id)).toEqual(["control-plane", "site-a", "site-b"]);
	});
});
