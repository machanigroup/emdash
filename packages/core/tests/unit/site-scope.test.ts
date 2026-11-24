import { describe, expect, it } from "vitest";

import { runWithContext } from "../../src/request-context.js";
import { siteScopedGlobal, siteScopedKey } from "../../src/site-scope.js";

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

describe("siteScopedKey", () => {
	it("leaves default-site keys unchanged and suffixes other sites", () => {
		expect(siteScopedKey("posts")).toBe("posts");
		expect(inSite("site-a", () => siteScopedKey("posts"))).toBe("posts@site:site-a");
	});
});
