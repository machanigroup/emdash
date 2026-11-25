import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/seed", () => ({ seed: { version: "1" }, userSeed: null }), {
	virtual: true,
});

import type { Kysely } from "kysely";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { GET as authMode } from "../../../src/astro/routes/api/auth/mode.js";
import { POST as adminVerify } from "../../../src/astro/routes/api/setup/admin-verify.js";
import { POST as adminStart } from "../../../src/astro/routes/api/setup/admin.js";
import { GET as status } from "../../../src/astro/routes/api/setup/status.js";
import type { Database } from "../../../src/database/types.js";
import { CONTROL_PLANE_SITE_ID } from "../../../src/multisite/ids.js";
import { runWithContext } from "../../../src/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const config: EmDashConfig = {
	authProviders: [{ id: "google", label: "Google", adminEntry: "x" }],
	multiSite: {
		controlPlane: {},
		databases: {},
		adminUrl: "https://admin.example.com",
		signInDomains: ["machanigroup.com"],
	},
};

let db: Kysely<Database>;

beforeEach(async () => {
	db = await setupTestDatabase();
});

afterEach(async () => {
	await teardownTestDatabase(db);
});

function call(
	route: (context: never) => Response | Promise<Response>,
	siteId: string | undefined,
	method = "GET",
) {
	const request =
		method === "POST"
			? new Request("https://admin.example.com/_emdash/api/setup", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email: "x@gmail.com", name: "X" }),
				})
			: new Request("https://admin.example.com/_emdash/api/setup");
	return runWithContext({ editMode: false, siteId }, () =>
		route({
			request,
			url: new URL(request.url),
			locals: { emdash: { db, config } },
			cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		} as never),
	);
}

describe("multi-site admin host setup", () => {
	it.each([
		["start", adminStart],
		["verify", adminVerify],
	])("refuses to create the first administrator with a passkey (%s)", async (_label, route) => {
		const response = await call(route as never, CONTROL_PLANE_SITE_ID, "POST");
		expect(response.status).toBe(403);
		const users = await db.selectFrom("users").select("id").execute();
		expect(users).toEqual([]);
	});

	it("reports a first run that only signs in the first administrator", async () => {
		const response = await call(status as never, CONTROL_PLANE_SITE_ID);
		const body = (await response.json()) as { data: Record<string, unknown> };
		expect(body.data).toEqual({
			needsSetup: true,
			multiSite: { signInDomains: ["machanigroup.com"] },
		});
	});

	it("tells the login page to offer only the providers", async () => {
		const response = await call(authMode as never, CONTROL_PLANE_SITE_ID);
		const body = (await response.json()) as { data: { providersOnly?: boolean } };
		expect(body.data.providersOnly).toBe(true);
	});

	it("keeps the usual setup on a site", async () => {
		const response = await call(status as never, "site-a");
		const body = (await response.json()) as { data: Record<string, unknown> };
		expect(body.data.multiSite).toBeUndefined();
		expect(body.data.step).toBeDefined();
		const mode = (await (await call(authMode as never, "site-a")).json()) as {
			data: { providersOnly?: boolean };
		};
		expect(mode.data.providersOnly).toBeUndefined();
	});
});
