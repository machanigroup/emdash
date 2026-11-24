import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { VIRTUAL_CONFIG, mockRuntimeCreate, mockGetDb, mockResolve } = vi.hoisted(() => ({
	VIRTUAL_CONFIG: {
		database: { entrypoint: "test", config: { url: "default" }, type: "sqlite" },
		migrations: { runtime: "check", dev: "check" },
		multiSite: {
			controlPlane: { url: "control" },
			databases: { "brand-a": { url: "brand-a" }, "brand-b": { url: "brand-b" } },
		},
	},
	mockRuntimeCreate: vi.fn(),
	mockGetDb: vi.fn(),
	mockResolve: vi.fn(),
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
	EmDashRuntime: { create: mockRuntimeCreate },
}));
vi.mock("../../../src/loader.js", () => ({ getDb: mockGetDb }));
vi.mock("../../../src/astro/middleware/site.js", () => ({
	getSiteRouter: () => ({ resolve: mockResolve }),
}));

import onRequest from "../../../src/astro/middleware.js";
import { getRequestContext } from "../../../src/request-context.js";

const store = globalThis as Record<symbol, unknown>;

function contextFor(url: string) {
	const parsed = new URL(url);
	return {
		request: new Request(parsed),
		url: parsed,
		cookies: { get: vi.fn(() => undefined), set: vi.fn(), headers: () => [] },
		locals: {} as Record<string, unknown>,
		redirect: vi.fn(),
		isPrerendered: false,
		session: { get: vi.fn(async () => null) },
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
	};
}

function siteFor(siteId: string, url: string) {
	return {
		siteId,
		orgId: "org-1",
		config: { ...VIRTUAL_CONFIG, database: { ...VIRTUAL_CONFIG.database, config: { url } } },
	};
}

describe("multi-site request routing", () => {
	beforeEach(() => {
		delete store[Symbol.for("emdash:runtime-holder")];
		delete store[Symbol.for("emdash:runtime-holder@sites")];
		mockGetDb.mockReset();
		mockResolve.mockReset();
		mockRuntimeCreate.mockReset();
		mockRuntimeCreate.mockImplementation(async (deps: { siteId?: string }) =>
			fakeRuntime(deps.siteId ?? "default"),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("returns 404 for a hostname no site lists, without opening any site", async () => {
		mockResolve.mockResolvedValue(null);
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(contextFor("https://unknown.example/") as never, next);

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(next).not.toHaveBeenCalled();
		expect(mockRuntimeCreate).not.toHaveBeenCalled();
		expect(mockGetDb).not.toHaveBeenCalled();
	});

	it("renders a site's page on that site's runtime and database", async () => {
		mockResolve.mockImplementation(async (hostname: string) =>
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
		mockResolve.mockResolvedValue(siteFor("site-a", "brand-a"));
		mockRuntimeCreate.mockRejectedValue(new Error("connection reset"));
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(contextFor("https://brand-a.com/") as never, next);

		expect(response.status).toBe(503);
		expect(next).not.toHaveBeenCalled();
		expect(mockGetDb).not.toHaveBeenCalled();
	});

	it("returns 503 when the control plane cannot be read", async () => {
		mockResolve.mockRejectedValue(new Error("control plane offline"));
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(contextFor("https://brand-a.com/") as never, next);

		expect(response.status).toBe(503);
		expect(next).not.toHaveBeenCalled();
	});
});
