import { Role } from "@emdash-cms/auth";
import { describe, expect, it } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { CONTROL_PLANE_SITE_ID } from "../../../src/multisite/ids.js";
import {
	adminHostSignInDomains,
	adminHostSignup,
	emailInDomains,
} from "../../../src/multisite/sign-in.js";
import { runWithContext } from "../../../src/request-context.js";

const config: EmDashConfig = {
	multiSite: {
		controlPlane: {},
		databases: {},
		adminUrl: "https://admin.example.com",
		signInDomains: ["MachaniGroup.com"],
	},
};

function onAdminHost<T>(fn: () => T, siteId = CONTROL_PLANE_SITE_ID): T {
	return runWithContext({ editMode: false, siteId }, fn);
}

describe("admin host sign-in domains", () => {
	it("applies only on the admin host", () => {
		expect(onAdminHost(() => adminHostSignInDomains(config))).toEqual(["machanigroup.com"]);
		expect(onAdminHost(() => adminHostSignInDomains(config), "site-a")).toBeNull();
		expect(adminHostSignInDomains(config)).toBeNull();
	});

	it("applies only when domains and an admin host are configured", () => {
		const noDomains = { multiSite: { ...config.multiSite!, signInDomains: [] } };
		const noAdmin = { multiSite: { ...config.multiSite!, adminUrl: undefined } };
		expect(onAdminHost(() => adminHostSignInDomains(noDomains))).toBeNull();
		expect(onAdminHost(() => adminHostSignInDomains(noAdmin))).toBeNull();
	});

	it("matches the email's domain exactly, ignoring case", () => {
		expect(emailInDomains("Ravi@MachaniGroup.com", ["machanigroup.com"])).toBe(true);
		expect(emailInDomains("ravi@evil-machanigroup.com", ["machanigroup.com"])).toBe(false);
		expect(emailInDomains("ravi@machanigroup.com.evil.example", ["machanigroup.com"])).toBe(false);
		expect(emailInDomains("not-an-email", ["machanigroup.com"])).toBe(false);
	});
});

describe("adminHostSignup", () => {
	const invited =
		(...emails: string[]) =>
		async (email: string) =>
			emails.includes(email);
	const nobody = invited();

	it("makes the first allowed account the deployment Admin", async () => {
		expect(
			await onAdminHost(() => adminHostSignup(config, "priya@machanigroup.com", false, nobody)),
		).toEqual({ allowed: true, role: Role.ADMIN });
	});

	it("refuses other domains for the first account", async () => {
		expect(
			await onAdminHost(() => adminHostSignup(config, "someone@gmail.com", false, nobody)),
		).toBeNull();
	});

	it("refuses anyone without an invitation once set up, even from a sign-in domain", async () => {
		expect(
			await onAdminHost(() => adminHostSignup(config, "ravi@machanigroup.com", true, nobody)),
		).toBeNull();
		expect(
			await onAdminHost(() => adminHostSignup(config, "someone@gmail.com", true, nobody)),
		).toBeNull();
	});

	it("lets invited people in with no deployment-wide role, from any domain", async () => {
		const check = invited("ravi@machanigroup.com", "writer@gmail.com");
		for (const email of ["ravi@machanigroup.com", "writer@gmail.com"]) {
			expect(await onAdminHost(() => adminHostSignup(config, email, true, check))).toEqual({
				allowed: true,
				role: Role.SUBSCRIBER,
			});
		}
	});

	it("leaves sites and single-site deployments to the usual rules", async () => {
		expect(
			await onAdminHost(() => adminHostSignup(config, "a@gmail.com", false, nobody), "site-a"),
		).toBeUndefined();
		expect(
			await onAdminHost(() => adminHostSignup({}, "a@gmail.com", false, nobody)),
		).toBeUndefined();
	});
});
