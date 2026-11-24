import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	invalidateRedirectCache,
	loadCachedRedirects,
	type RedirectRuleSet,
	type RedirectSource,
} from "../../../src/redirects/cache.js";
import { runWithContext } from "../../../src/request-context.js";
import { filterToRegisteredCollections } from "../../../src/schema/collection-slugs-cache.js";
import {
	getSiteSettings,
	invalidateSiteSettingsCache,
	setSiteSettings,
} from "../../../src/settings/index.js";
import { setupTestDatabase, setupTestDatabaseWithCollections } from "../../utils/test-db.js";

function asSite<T>(siteId: string | undefined, db: Kysely<Database>, fn: () => Promise<T>) {
	return runWithContext({ editMode: false, siteId, db }, fn);
}

function redirectsTo(destination: string): RedirectSource {
	const rules: RedirectRuleSet = {
		version: destination,
		exact: [{ id: "r1", source: "/old", destination, type: 301 }],
		patterns: [],
	};
	return { load: async () => rules, isCurrent: async (version) => version === destination };
}

describe("multi-site cache isolation", () => {
	let defaultDb: Kysely<Database>;
	let siteA: Kysely<Database>;
	let siteB: Kysely<Database>;

	beforeEach(async () => {
		defaultDb = await setupTestDatabase();
		siteA = await setupTestDatabaseWithCollections();
		siteB = await setupTestDatabase();
		for (const [siteId, db] of [
			[undefined, defaultDb],
			["site-a", siteA],
			["site-b", siteB],
		] as const) {
			await asSite(siteId, db, async () => {
				invalidateSiteSettingsCache();
				invalidateRedirectCache();
			});
		}
		await setSiteSettings({ title: "Default site" }, defaultDb);
		await setSiteSettings({ title: "Brand A" }, siteA);
		await setSiteSettings({ title: "Brand B" }, siteB);
	});

	it("serves each site its own cached settings", async () => {
		expect((await asSite("site-a", siteA, getSiteSettings)).title).toBe("Brand A");
		expect((await asSite("site-b", siteB, getSiteSettings)).title).toBe("Brand B");
		expect((await asSite(undefined, defaultDb, getSiteSettings)).title).toBe("Default site");

		await setSiteSettings({ title: "Brand A, renamed" }, siteA);
		expect((await asSite("site-a", siteA, getSiteSettings)).title).toBe("Brand A");
		await asSite("site-a", siteA, async () => invalidateSiteSettingsCache());

		expect((await asSite("site-a", siteA, getSiteSettings)).title).toBe("Brand A, renamed");
		expect((await asSite("site-b", siteB, getSiteSettings)).title).toBe("Brand B");
	});

	it("serves each site its own cached redirects", async () => {
		const destination = async (siteId: string, db: Kysely<Database>, source: RedirectSource) =>
			asSite(siteId, db, async () => (await loadCachedRedirects(source)).exact.get("/old"));

		expect((await destination("site-a", siteA, redirectsTo("/a")))?.destination).toBe("/a");
		expect((await destination("site-b", siteB, redirectsTo("/b")))?.destination).toBe("/b");
		expect((await destination("site-a", siteA, redirectsTo("/ignored")))?.destination).toBe("/a");
	});

	it("keeps registered collections apart", async () => {
		const registered = (siteId: string, db: Kysely<Database>) =>
			asSite(siteId, db, () => filterToRegisteredCollections(db, ["post", "page"]));

		const inA = await registered("site-a", siteA);
		expect(inA.length).toBeGreaterThan(0);
		expect(await registered("site-b", siteB)).toEqual([]);
		expect(await registered("site-a", siteA)).toEqual(inA);
	});
});
