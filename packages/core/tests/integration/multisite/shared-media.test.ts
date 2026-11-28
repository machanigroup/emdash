import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleAddMember,
	handleCreateOrg,
	handleCreateSite,
	handleUpdateSite,
	type MultiSiteActor,
	type MultiSiteHandlerContext,
} from "../../../src/api/handlers/multisite.js";
import {
	handleListSharedMedia,
	handleListSharedMediaSources,
	siteMediaUrlResolver,
	type SharedMediaUrl,
} from "../../../src/api/handlers/shared-media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { normalizeMediaValue } from "../../../src/media/normalize.js";
import { buildRenderMediaUrl } from "../../../src/media/url.js";
import { runControlPlaneMigrations } from "../../../src/multisite/migrations.js";
import type { ControlPlaneDatabase } from "../../../src/multisite/types.js";
import { createStorage as createLocalStorage } from "../../../src/storage/local.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

const admin: MultiSiteActor = { id: "user-admin", role: Role.ADMIN };
const priya: MultiSiteActor = { id: "user-priya", role: Role.SUBSCRIBER };
const ravi: MultiSiteActor = { id: "user-ravi", role: Role.SUBSCRIBER };
const outsider: MultiSiteActor = { id: "user-out", role: Role.SUBSCRIBER };

function ok<T>(result: { success: boolean; data?: T; error?: unknown }): T {
	if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
	return result.data as T;
}

const publicUrls = (origin: string): SharedMediaUrl =>
	siteMediaUrlResolver(
		{
			siteUrl: origin,
			storage: {
				entrypoint: "emdash/storage/local",
				config: { directory: "/unused", baseUrl: "/_emdash/api/media/file" },
			},
		},
		createLocalStorage,
	);

describe("siteMediaUrlResolver", () => {
	it("uses the storage's public URL when it has one", () => {
		const url = siteMediaUrlResolver(
			{
				siteUrl: "https://svasa.example",
				storage: {
					entrypoint: "emdash/storage/local",
					config: { directory: "/unused", baseUrl: "https://media.example.com/svasa-life" },
				},
			},
			createLocalStorage,
		);
		expect(url("01ABC.jpg")).toBe("https://media.example.com/svasa-life/01ABC.jpg");
	});

	it("puts the media file route on the site's own hostname otherwise", () => {
		expect(publicUrls("https://svasa.example/blog")("01ABC.jpg")).toBe(
			"https://svasa.example/_emdash/api/media/file/01ABC.jpg",
		);
	});

	it("has no URL for a site without a hostname or a public storage URL", () => {
		const url = siteMediaUrlResolver(
			{ storage: { entrypoint: "local", config: { baseUrl: "/_emdash/api/media/file" } } },
			createLocalStorage,
		);
		expect(url("01ABC.jpg")).toBeNull();
	});
});

describeEachDialect("shared media library", (dialect) => {
	let db: DialectTestContext;
	let machaniDb: DialectTestContext;
	let svasaDb: DialectTestContext;
	let ctx: MultiSiteHandlerContext;
	let controlPlane: Kysely<ControlPlaneDatabase>;
	let machaniSite: string;
	let svasaSite: string;
	let siteDatabases: Map<string, Kysely<Database>>;
	const urls = async (siteId: string) =>
		siteId === svasaSite
			? publicUrls("https://svasa.example")
			: publicUrls("https://machani.example");

	beforeEach(async () => {
		db = await setupForDialect(dialect);
		controlPlane = db.db.withTables<ControlPlaneDatabase>();
		await runControlPlaneMigrations(controlPlane);
		for (const [id, email] of [
			[admin.id, "admin@example.com"],
			[priya.id, "priya@example.com"],
			[ravi.id, "ravi@example.com"],
			[outsider.id, "out@example.com"],
		] as const) {
			await db.db
				.insertInto("users")
				.values({ id, email, name: id, role: 10, email_verified: 1 })
				.execute();
		}
		machaniDb = await setupForDialect(dialect);
		svasaDb = await setupForDialect(dialect);
		siteDatabases = new Map();
		const multiSite = {
			controlPlane: { url: "control" },
			databases: { machani: { url: "machani" }, svasa: { url: "svasa" } },
			adminUrl: "https://admin.example.com",
		};
		ctx = {
			controlPlane,
			accounts: db.db,
			config: multiSite,
			deployment: {
				database: { entrypoint: "test", type: "sqlite", config: { url: "default" } },
				multiSite,
			},
			siteDatabase: async (siteId) => siteDatabases.get(siteId) ?? null,
			invalidateHosts: () => {},
		};

		const machaniOrg = ok(
			await handleCreateOrg(ctx, admin, { slug: "machani", name: "Machani" }),
		).id;
		const svasaOrg = ok(await handleCreateOrg(ctx, admin, { slug: "svasa", name: "Svasa" })).id;
		machaniSite = ok(
			await handleCreateSite(ctx, admin, machaniOrg, {
				slug: "machani-group",
				name: "Machani Group",
				databaseRef: "machani",
				hostnames: ["machani.example"],
			}),
		).id;
		svasaSite = ok(
			await handleCreateSite(ctx, admin, svasaOrg, {
				slug: "svasa-life",
				name: "Svasa Life",
				databaseRef: "svasa",
				hostnames: ["svasa.example"],
			}),
		).id;
		siteDatabases.set(machaniSite, machaniDb.db);
		siteDatabases.set(svasaSite, svasaDb.db);

		ok(
			await handleAddMember(ctx, admin, machaniOrg, {
				email: "priya@example.com",
				role: Role.AUTHOR,
			}),
		);
		ok(
			await handleAddMember(ctx, admin, machaniOrg, {
				email: "ravi@example.com",
				role: Role.EDITOR,
			}),
		);
		ok(
			await handleAddMember(ctx, admin, svasaOrg, { email: "ravi@example.com", role: Role.AUTHOR }),
		);

		const svasaMedia = new MediaRepository(svasaDb.db);
		for (const filename of ["beach.jpg", "villa.jpg", "brochure.pdf"]) {
			await svasaMedia.create({
				filename,
				mimeType: filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
				storageKey: `${filename.split(".")[0]}-key.${filename.split(".")[1]}`,
				width: filename.endsWith(".pdf") ? undefined : 1200,
				height: filename.endsWith(".pdf") ? undefined : 800,
				alt: `Svasa ${filename}`,
			});
		}
		await new MediaRepository(machaniDb.db).create({
			filename: "logo.png",
			mimeType: "image/png",
			storageKey: "logo-key.png",
		});
	});

	afterEach(async () => {
		await teardownForDialect(db);
		await teardownForDialect(machaniDb);
		await teardownForDialect(svasaDb);
	});

	it("offers only the sites a person can reach as media sources", async () => {
		const names = async (actor: MultiSiteActor) =>
			ok(await handleListSharedMediaSources(ctx, actor)).items.map((site) => site.name);
		expect(await names(priya)).toEqual(["Machani Group"]);
		expect(await names(ravi)).toEqual(["Machani Group", "Svasa Life"]);
		expect(await names(outsider)).toEqual([]);
		expect((await names(admin)).toSorted()).toEqual(["Machani Group", "Svasa Life"]);
	});

	it("lists another site's media for a member of both sites, with absolute URLs", async () => {
		const list = ok(await handleListSharedMedia(ctx, ravi, svasaSite, {}, urls));
		expect(list.items.map((item) => item.filename).toSorted()).toEqual([
			"beach.jpg",
			"brochure.pdf",
			"villa.jpg",
		]);
		const beach = list.items.find((item) => item.filename === "beach.jpg")!;
		expect(beach).toMatchObject({
			url: "https://svasa.example/_emdash/api/media/file/beach-key.jpg",
			site: { id: svasaSite, name: "Svasa Life" },
			width: 1200,
			height: 800,
			alt: "Svasa beach.jpg",
		});
	});

	it("hides a site from people who can't reach it", async () => {
		for (const actor of [priya, outsider]) {
			expect(await handleListSharedMedia(ctx, actor, svasaSite, {}, urls)).toMatchObject({
				success: false,
				error: { code: "NOT_FOUND" },
			});
		}
		expect(await handleListSharedMedia(ctx, ravi, "no-such-site", {}, urls)).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});
		expect(ok(await handleListSharedMedia(ctx, priya, machaniSite, {}, urls)).items).toHaveLength(
			1,
		);
	});

	it("stops listing a site once it is disabled, even for deployment Admins", async () => {
		ok(await handleUpdateSite(ctx, admin, svasaSite, { status: "disabled" }));
		for (const actor of [admin, ravi]) {
			expect(await handleListSharedMedia(ctx, actor, svasaSite, {}, urls)).toMatchObject({
				success: false,
				error: { code: "NOT_FOUND" },
			});
		}
	});

	it("pages through another site's media by cursor and by page, and filters it", async () => {
		const first = ok(await handleListSharedMedia(ctx, ravi, svasaSite, { limit: 2 }, urls));
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).toBeTruthy();
		const second = ok(
			await handleListSharedMedia(
				ctx,
				ravi,
				svasaSite,
				{ limit: 2, cursor: first.nextCursor },
				urls,
			),
		);
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeUndefined();
		expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);

		const paged = ok(
			await handleListSharedMedia(ctx, ravi, svasaSite, { page: 2, limit: 2 }, urls),
		);
		expect(paged.totalCount).toBe(3);
		expect(paged.items).toHaveLength(1);

		const images = ok(
			await handleListSharedMedia(ctx, ravi, svasaSite, { mimeType: "image/" }, urls),
		);
		expect(images.items.map((item) => item.mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
		const search = ok(await handleListSharedMedia(ctx, ravi, svasaSite, { q: "villa" }, urls));
		expect(search.items.map((item) => item.filename)).toEqual(["villa.jpg"]);
	});

	it("refuses to list media that would have no working address", async () => {
		const noAddress = async () =>
			siteMediaUrlResolver({ storage: { entrypoint: "local", config: {} } }, createLocalStorage);
		expect(await handleListSharedMedia(ctx, ravi, svasaSite, {}, noAddress)).toMatchObject({
			success: false,
			error: { code: "MEDIA_NOT_PUBLIC" },
			status: 409,
		});
	});

	it("gives a picked item a reference the current site renders without its own media table", async () => {
		const list = ok(await handleListSharedMedia(ctx, ravi, svasaSite, { q: "beach" }, urls));
		const picked = list.items[0]!;
		const value = {
			provider: "external",
			id: "",
			src: picked.url,
			alt: picked.alt ?? "",
			width: picked.width ?? undefined,
			height: picked.height ?? undefined,
		};
		const lookups: string[] = [];
		const normalized = await normalizeMediaValue(value, (id) => {
			lookups.push(id);
			return undefined;
		});
		expect(lookups).toEqual([]);
		expect(normalized).toMatchObject({ provider: "external", id: "", src: picked.url });
		expect(
			buildRenderMediaUrl((key) => `https://machani-cdn.example/${key}`, { url: normalized!.src }),
		).toBe("https://svasa.example/_emdash/api/media/file/beach-key.jpg");
		expect(await new MediaRepository(machaniDb.db).findById(picked.id)).toBeNull();
	});
});
