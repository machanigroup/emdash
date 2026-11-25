/**
 * When each site last served a request in this worker, so sites that have
 * gone idle can be released.
 */

const ACTIVITY_KEY = Symbol.for("emdash:multi-site-activity");
const store = globalThis as Record<symbol, unknown>;

interface SiteActivity {
	lastUsed: Map<string, number>;
	lastEvictionPass: number;
}

function activity(): SiteActivity {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot, written only below
	let state = store[ACTIVITY_KEY] as SiteActivity | undefined;
	if (!state) {
		state = { lastUsed: new Map(), lastEvictionPass: 0 };
		store[ACTIVITY_KEY] = state;
	}
	return state;
}

export function recordSiteUse(siteId: string, now = Date.now()): void {
	activity().lastUsed.set(siteId, now);
}

/** When `siteId` last served a request, or 0 when it hasn't in this worker. */
export function lastSiteUse(siteId: string): number {
	return activity().lastUsed.get(siteId) ?? 0;
}

export function forgetSiteActivity(siteId: string): void {
	activity().lastUsed.delete(siteId);
}

/**
 * Whether the caller should check for idle sites now. Returns true at most
 * once per `intervalMs`, so the check stays off the request path.
 */
export function claimEvictionPass(now: number, intervalMs: number): boolean {
	const state = activity();
	if (now - state.lastEvictionPass < intervalMs) return false;
	state.lastEvictionPass = now;
	return true;
}
