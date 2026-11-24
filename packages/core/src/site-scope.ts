/**
 * Isolate-wide state that a multi-site deployment must keep apart per site.
 *
 * A request for the default site (no `siteId` in its request context) reads
 * and writes the same `globalThis` slot a single-site deployment uses. A
 * request for another site gets its own slot, created on first use, so one
 * site's cached settings, schema, or redirects are never served to another.
 */

import { getRequestContext } from "./request-context.js";

const store = globalThis as Record<symbol, unknown>;

export function currentSiteId(): string | undefined {
	return getRequestContext()?.siteId;
}

function siteSlots<T>(key: symbol): Map<string, T> {
	const slotsKey = Symbol.for(`${key.description ?? "emdash:site-scoped"}@sites`);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot, written only below
	let slots = store[slotsKey] as Map<string, T> | undefined;
	if (!slots) {
		slots = new Map();
		store[slotsKey] = slots;
	}
	return slots;
}

/**
 * Returns the current site's value for `key`, creating it with `create` on
 * first use. Call it on every access rather than caching the result in a
 * module-scope constant, because the site differs from request to request.
 */
export function siteScopedGlobal<T>(key: symbol, create: () => T): T {
	const siteId = currentSiteId();
	if (siteId === undefined) {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot, written only below
		let value = store[key] as T | undefined;
		if (value === undefined) {
			value = create();
			store[key] = value;
		}
		return value;
	}
	const slots = siteSlots<T>(key);
	let value = slots.get(siteId);
	if (value === undefined) {
		value = create();
		slots.set(siteId, value);
	}
	return value;
}

/** Appends the current site to a cache key, leaving default-site keys unchanged. */
export function siteScopedKey(key: string): string {
	const siteId = currentSiteId();
	return siteId === undefined ? key : `${key}@site:${siteId}`;
}
