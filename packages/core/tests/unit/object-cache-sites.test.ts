import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	getLastContentWriteAt,
	invalidateObjectCache,
} from "../../src/object-cache/index.js";
import { createObjectCache as createMemoryCache } from "../../src/object-cache/memory.js";
import { runWithContext } from "../../src/request-context.js";

function asSite<T>(siteId: string | undefined, fn: () => Promise<T>): Promise<T> {
	return runWithContext({ editMode: false, siteId }, fn);
}

function title(siteId: string | undefined, value: string): Promise<string> {
	return asSite(siteId, () =>
		cachedQuery({ namespace: "settings", key: "title", load: async () => value }),
	);
}

describe("object cache across sites", () => {
	beforeEach(() => {
		__setObjectCacheBackendForTests(createMemoryCache({}), { revalidate: 60_000 });
	});

	afterEach(() => {
		__setObjectCacheBackendForTests(null);
	});

	it("keeps each site's cached values apart", async () => {
		expect(await title("site-a", "Brand A")).toBe("Brand A");
		expect(await title("site-b", "Brand B")).toBe("Brand B");
		expect(await title(undefined, "Default")).toBe("Default");
		await waitForDeferredTasks();

		expect(await title("site-a", "reloaded")).toBe("Brand A");
		expect(await title("site-b", "reloaded")).toBe("Brand B");
		expect(await title(undefined, "reloaded")).toBe("Default");
	});

	it("invalidates only the site that changed", async () => {
		await title("site-a", "Brand A");
		await title("site-b", "Brand B");
		await waitForDeferredTasks();

		await asSite("site-a", async () => invalidateObjectCache("settings"));
		await waitForDeferredTasks();

		expect(await title("site-a", "Brand A, renamed")).toBe("Brand A, renamed");
		expect(await title("site-b", "reloaded")).toBe("Brand B");
	});

	it("tracks content writes per site", async () => {
		await asSite("site-a", async () => invalidateObjectCache("content:posts"));
		await waitForDeferredTasks();

		expect(await asSite("site-a", getLastContentWriteAt)).toBeGreaterThan(0);
		expect(await asSite("site-b", getLastContentWriteAt)).toBe(0);
	});
});
