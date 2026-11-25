import { describe, expect, it } from "vitest";

import { runWithContext } from "../../src/request-context.js";
import { forgetSite, siteScopedGlobal } from "../../src/site-scope.js";

const KEY = Symbol.for("emdash:test:site-scope");

function inSite<T>(siteId: string | undefined, fn: () => T): T {
	return runWithContext({ editMode: false, siteId }, fn);
}

describe("siteScopedGlobal", () => {
	it("keeps the default site in the plain globalThis slot", () => {
		const value = inSite(undefined, () => siteScopedGlobal(KEY, () => ({ owner: "default" })));
		expect((globalThis as Record<symbol, unknown>)[KEY]).toBe(value);
		expect(siteScopedGlobal(KEY, () => ({ owner: "other" }))).toBe(value);
	});

	it("gives each site its own value", () => {
		const a = inSite("site-a", () => siteScopedGlobal(KEY, () => ({ owner: "a" })));
		const b = inSite("site-b", () => siteScopedGlobal(KEY, () => ({ owner: "b" })));
		const defaultValue = siteScopedGlobal(KEY, () => ({ owner: "default" }));

		expect(a).toEqual({ owner: "a" });
		expect(b).toEqual({ owner: "b" });
		expect(defaultValue).not.toBe(a);
		expect(inSite("site-a", () => siteScopedGlobal(KEY, () => ({ owner: "again" })))).toBe(a);
	});
});

describe("forgetSite", () => {
	it("releases a site's values and leaves other sites' values in place", () => {
		const a = inSite("site-a", () => siteScopedGlobal(KEY, () => ({ owner: "a" })));
		const b = inSite("site-b", () => siteScopedGlobal(KEY, () => ({ owner: "b" })));

		forgetSite("site-a");

		expect(inSite("site-a", () => siteScopedGlobal(KEY, () => ({ owner: "new" })))).not.toBe(a);
		expect(inSite("site-b", () => siteScopedGlobal(KEY, () => ({ owner: "new" })))).toBe(b);
	});
});
