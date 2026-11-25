import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock("../../../src/api/handlers/api-tokens.js", () => ({
	resolveApiToken: vi.fn(async () => ({ userId: "user-1", scopes: ["admin"], tokenId: "t1" })),
	resolveOAuthToken: vi.fn(async () => null),
}));

vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: vi.fn(() => ({
		getUserById: vi.fn(async (id: string) => ({ id, role: 50, disabled: false })),
		getUserByEmail: vi.fn(),
	})),
}));

import { runWithContext } from "../../../src/request-context.js";

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

const refreshSiteAccount = vi.fn<(userId: string) => Promise<number | null>>();

beforeEach(() => {
	refreshSiteAccount.mockReset();
});

async function request(
	headers: Record<string, string>,
	session: { id: string } | undefined,
	pathname = "/_emdash/api/content/posts",
) {
	const url = new URL(pathname, "https://brand-a.com");
	const locals: Record<string, unknown> = { emdash: { db: {}, config: {} } };
	const next = vi.fn(async () => new Response("ok"));
	const destroy = vi.fn();
	const response = await runWithContext(
		{ editMode: false, siteId: "site-a", refreshSiteAccount },
		() =>
			onRequest(
				{
					url,
					request: new Request(url, { headers }),
					locals,
					cookies: { get: () => undefined },
					session: { get: vi.fn(async () => session), set: vi.fn(), destroy },
					redirect: (location: string) =>
						new Response(null, { status: 302, headers: { Location: location } }),
				} as unknown as Parameters<AuthMiddlewareModule["onRequest"]>[0],
				next,
			),
	);
	return { response, next, locals, destroy };
}

describe("site account refresh on a multi-site hostname", () => {
	it("uses the role the control plane gives an API token's user now", async () => {
		refreshSiteAccount.mockResolvedValue(30);
		const { next, locals } = await request({ Authorization: "Bearer ec_pat_x" }, undefined);

		expect(refreshSiteAccount).toHaveBeenCalledWith("user-1");
		expect(next).toHaveBeenCalledOnce();
		expect((locals.user as { role: number }).role).toBe(30);
	});

	it("rejects an API token whose user lost access to the site", async () => {
		refreshSiteAccount.mockResolvedValue(null);
		const { response, next } = await request({ Authorization: "Bearer ec_pat_x" }, undefined);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
	});

	it("ends the session of a user who lost access to the site", async () => {
		refreshSiteAccount.mockResolvedValue(null);
		const { response, next, destroy } = await request({}, { id: "user-1" });

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		expect(destroy).toHaveBeenCalled();
	});
});
