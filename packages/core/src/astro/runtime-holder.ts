import type { EmDashRuntime } from "../emdash-runtime.js";
import { createInitLock, type InitLock } from "../utils/init-lock.js";

// SSR chunks and the dev-server plugin must share the same runtime and init lock.
const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
const SITE_RUNTIME_HOLDERS_KEY = Symbol.for("emdash:runtime-holder@sites");
const store = globalThis as Record<symbol, unknown>;

interface RuntimeHolder {
	instance: EmDashRuntime | null;
	lock: InitLock;
	closed: boolean;
}

function createHolder(): RuntimeHolder {
	return { instance: null, lock: createInitLock(), closed: false };
}

function siteHolders(): Map<string, RuntimeHolder> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let holders = store[SITE_RUNTIME_HOLDERS_KEY] as Map<string, RuntimeHolder> | undefined;
	if (!holders) {
		holders = new Map();
		store[SITE_RUNTIME_HOLDERS_KEY] = holders;
	}
	return holders;
}

/** The runtime holder for a site, or for the default site when `siteId` is undefined. */
export function getRuntimeHolder(siteId?: string): RuntimeHolder {
	if (siteId !== undefined) {
		const holders = siteHolders();
		let holder = holders.get(siteId);
		if (!holder) {
			holder = createHolder();
			holders.set(siteId, holder);
		}
		return holder;
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let holder = store[RUNTIME_HOLDER_KEY] as RuntimeHolder | undefined;
	if (!holder) {
		holder = createHolder();
		store[RUNTIME_HOLDER_KEY] = holder;
	}
	return holder;
}

async function shutdownHolder(holder: RuntimeHolder): Promise<void> {
	// Detach before awaiting so the next server cannot reuse a closing runtime.
	holder.closed = true;
	const runtime = holder.instance;
	holder.instance = null;
	await runtime?.shutdown();
}

export async function shutdownRuntime(): Promise<void> {
	delete store[Symbol.for("emdash:plugins")];
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	const holder = store[RUNTIME_HOLDER_KEY] as RuntimeHolder | undefined;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	const sites = store[SITE_RUNTIME_HOLDERS_KEY] as Map<string, RuntimeHolder> | undefined;
	delete store[RUNTIME_HOLDER_KEY];
	delete store[SITE_RUNTIME_HOLDERS_KEY];
	const holders = [...(holder ? [holder] : []), ...(sites?.values() ?? [])];
	const results = await Promise.allSettled(holders.map(shutdownHolder));
	const failure = results.find((result) => result.status === "rejected");
	if (failure) {
		console.error("[emdash] runtime shutdown failed:", failure.reason);
		throw failure.reason;
	}
}
