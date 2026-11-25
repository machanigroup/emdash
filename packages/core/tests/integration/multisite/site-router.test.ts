import { Role } from "@emdash-cms/auth";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmDashConfig, MultiSiteConfig } from "../../../src/astro/integration/runtime.js";
import { createSiteRouter, siteConfig, siteOrigin } from "../../../src/astro/middleware/site.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	createOrganization,
	createSite,
	setOrgMember,
	setSiteStatus,
} from "../../../src/multisite/repository.js";
import { runWithContext } from "../../../src/request-context.js";

type MultiSiteDeployment = EmDashConfig & { multiSite: MultiSiteConfig };

function deployment(overrides: Partial<MultiSiteConfig> = {}): MultiSiteDeployment {
	return {
		database: {
			entrypoint: "emdash/db/sqlite",
			config: { url: "file:./default.db" },
			type: "sqlite",
		},
		storage: { entrypoint: "emdash/storage/local", config: { directory: "./uploads" } },
		multiSite: {
			controlPlane: { url: "file:./control.db" },
			databases: { "brand-a": { url: "file:./brand-a.db" } },
			storages: { "brand-a": { directory: "./uploads/brand-a" } },
			...overrides,
		},
	};
}

describe("siteConfig", () => {
	const host = {
		siteId: "s1",
		orgId: "o1",
		name: "Brand A",
		primaryHostname: "brand-a.com",
		databaseRef: "brand-a",
		storageRef: "brand-a",
	};

	it("merges the named database and storage options over the deployment's", () => {
		const config = siteConfig(deployment(), host);
		expect(config.database).toEqual({
			entrypoint: "emdash/db/sqlite",
			config: { url: "file:./brand-a.db" },
			type: "sqlite",
		});
		expect(config.storage?.config).toEqual({ directory: "./uploads/brand-a" });
	});

	it("uses the site's primary hostname as its URL", () => {
		expect(siteConfig(deployment(), host).siteUrl).toBe("https://brand-a.com");
	});

	it("uses the deployment's options unchanged for the default ref", () => {
		const base = deployment();
		const config = siteConfig(base, { ...host, databaseRef: "default", storageRef: "default" });
		expect(config.database?.config).toEqual({ url: "file:./default.db" });
		expect(config.storage?.config).toEqual({ directory: "./uploads" });
	});

	it("shares the deployment's storage when a site names none", () => {
		const config = siteConfig(deployment(), { ...host, storageRef: null });
		expect(config.storage?.config).toEqual({ directory: "./uploads" });
	});

	it("refuses a site database that is the control-plane database", () => {
		const shared = deployment({ databases: { same: { url: "file:./control.db" } } });
		expect(() => siteConfig(shared, { ...host, databaseRef: "same" })).toThrow(
			/control-plane database/,
		);
		const controlIsDefault = deployment({ controlPlane: {} });
		expect(() => siteConfig(controlIsDefault, { ...host, databaseRef: "default" })).toThrow(
			/control-plane database/,
		);
	});

	it("refuses a database the config does not list", () => {
		expect(() => siteConfig(deployment(), { ...host, databaseRef: "../../etc/passwd" })).toThrow(
			/not listed in multiSite.databases/,
		);
		expect(() => siteConfig(deployment(), { ...host, databaseRef: "toString" })).toThrow(
			/not listed/,
		);
	});
});

describe("siteOrigin", () => {
	it("serves sites over https and localhost sites like the admin", () => {
		expect(siteOrigin("brand-a.com", "http://localhost:4321")).toBe("https://brand-a.com");
		expect(siteOrigin("brand-a.localhost", "http://localhost:4321")).toBe(
			"http://brand-a.localhost:4321",
		);
		expect(siteOrigin("localhost", undefined)).toBe("https://localhost");
	});
});

describe("createSiteRouter", () => {
	let sqlite: ReturnType<typeof openNodeSqliteDatabase>;
	const dialectOptions: unknown[] = [];
	const createDialect = (options: unknown) => {
		dialectOptions.push(options);
		return new SqliteDialect({ database: sqlite });
	};

	beforeEach(() => {
		sqlite = openNodeSqliteDatabase(":memory:");
		dialectOptions.length = 0;
	});

	afterEach(() => {
		sqlite.close();
	});

	async function registerBrandA(router: ReturnType<typeof createSiteRouter>) {
		await router.resolve("bootstrap.invalid");
		const org = await createOrganization(router.controlPlane, { slug: "acme", name: "Acme" });
		const site = await createSite(router.controlPlane, {
			orgId: org.id,
			slug: "brand-a",
			name: "Brand A",
			databaseRef: "brand-a",
			storageRef: "brand-a",
			hostnames: ["brand-a.com"],
		});
		await setOrgMember(router.controlPlane, org.id, "user-1", Role.EDITOR);
		router.invalidate();
		return site;
	}

	it("opens the control plane with its own options and migrates it", async () => {
		const router = createSiteRouter(deployment(), createDialect);
		expect(await router.resolve("brand-a.com")).toBeNull();
		expect(dialectOptions).toEqual([{ url: "file:./control.db" }]);
	});

	it("queries the control plane through the request's own connection", async () => {
		const router = createSiteRouter(deployment(), createDialect);
		const requestSqlite = openNodeSqliteDatabase(":memory:");
		const requestDb = new Kysely<Database>({
			dialect: new SqliteDialect({ database: requestSqlite }),
		});
		try {
			await runWithContext({ editMode: false, controlPlaneDb: requestDb }, async () => {
				expect(await router.resolve("brand-a.com")).toBeNull();
				expect(router.controlAccounts).toBe(requestDb);
			});
			expect(dialectOptions).toEqual([]);
			const tables = requestSqlite
				.prepare("SELECT name FROM sqlite_master WHERE name = '_emdash_sites'")
				.all();
			expect(tables).toHaveLength(1);
		} finally {
			await requestDb.destroy();
		}
	});

	it("runs the admin host on the control-plane database", () => {
		const router = createSiteRouter(
			deployment({ adminUrl: "https://admin.example.com/ignored" }),
			createDialect,
		);
		expect(router.adminHostname).toBe("admin.example.com");
		expect(router.adminConfig?.database?.config).toEqual({ url: "file:./control.db" });
		expect(router.adminConfig?.siteUrl).toBe("https://admin.example.com");
		expect(createSiteRouter(deployment(), createDialect).adminConfig).toBeNull();
	});

	it("finds a site by id", async () => {
		const router = createSiteRouter(deployment(), createDialect);
		const site = await registerBrandA(router);
		expect((await router.siteById(site.id))?.name).toBe("Brand A");
		expect(await router.siteById("missing")).toBeNull();
	});

	it("resolves a hostname to the site's config", async () => {
		const router = createSiteRouter(deployment(), createDialect);
		const site = await registerBrandA(router);

		const resolved = await router.resolve("Brand-A.com");
		expect(resolved?.siteId).toBe(site.id);
		expect(resolved?.config.database?.config).toEqual({ url: "file:./brand-a.db" });
		expect(await router.resolve("unknown.example")).toBeNull();
	});

	it("lists active sites for scheduled work and skips misconfigured ones", async () => {
		const router = createSiteRouter(deployment(), createDialect);
		const site = await registerBrandA(router);
		const org = await createOrganization(router.controlPlane, { slug: "other", name: "Other" });
		await createSite(router.controlPlane, {
			orgId: org.id,
			slug: "broken",
			name: "Broken",
			databaseRef: "not-configured",
			hostnames: ["broken.example"],
		});
		const disabled = await createSite(router.controlPlane, {
			orgId: org.id,
			slug: "off",
			name: "Off",
			databaseRef: "brand-a",
			hostnames: ["off.example"],
		});
		await setSiteStatus(router.controlPlane, disabled.id, "disabled");
		const errors = console.error;
		console.error = () => {};
		try {
			expect((await router.activeSites()).map((s) => s.siteId)).toEqual([site.id]);
		} finally {
			console.error = errors;
		}
	});

	it("picks up hostname changes in the background after the refresh interval", async () => {
		const router = createSiteRouter(deployment({ hostRefreshMs: 1 }), createDialect);
		await registerBrandA(router);
		expect(await router.resolve("brand-b.com")).toBeNull();

		const org = await createOrganization(router.controlPlane, { slug: "b", name: "B" });
		await createSite(router.controlPlane, {
			orgId: org.id,
			slug: "brand-b",
			name: "Brand B",
			databaseRef: "default",
			hostnames: ["brand-b.com"],
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(await router.resolve("brand-b.com")).toBeNull();
		await waitForDeferredTasks();
		expect((await router.resolve("brand-b.com"))?.config.database?.config).toEqual({
			url: "file:./default.db",
		});
	});
});
