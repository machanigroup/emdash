import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMediaStorageImport,
	handleMediaStorageScan,
	matchesStoragePattern,
} from "../../../src/api/handlers/media-storage-import.js";
import { GET, POST } from "../../../src/astro/routes/api/media/storage-import.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { LocalStorage } from "../../../src/storage/local.js";
import type { DownloadOptions, ListOptions, Storage } from "../../../src/storage/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function png(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	bytes.set([8, 6, 0, 0, 0], 24);
	return bytes;
}

/** A flat bucket listed the way R2 and S3 list: every key under a prefix, in key order. */
class BucketStorage implements Storage {
	readonly objects = new Map<string, Uint8Array>();

	put(key: string, body: Uint8Array = new Uint8Array(10)): this {
		this.objects.set(key, body);
		return this;
	}

	async list(options: ListOptions = {}) {
		const keys = [...this.objects.keys()]
			.filter((key) => key.startsWith(options.prefix ?? ""))
			.toSorted();
		const start = options.cursor ? Number(options.cursor) : 0;
		const end = start + (options.limit ?? 1000);
		return {
			files: keys.slice(start, end).map((key) => ({
				key,
				size: this.objects.get(key)!.byteLength,
				lastModified: new Date(0),
			})),
			nextCursor: end < keys.length ? String(end) : undefined,
		};
	}

	async download(key: string, options: DownloadOptions = {}) {
		const body = this.objects.get(key);
		if (!body) throw new Error(`missing ${key}`);
		const range = options.range && "offset" in options.range ? options.range : undefined;
		const part = range
			? body.slice(range.offset, range.offset + (range.length ?? body.length))
			: body;
		return {
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(part);
					controller.close();
				},
			}),
			contentType: "application/octet-stream",
			size: body.byteLength,
		};
	}

	async exists(key: string) {
		return this.objects.has(key);
	}

	async upload(): Promise<never> {
		throw new Error("not used");
	}

	async delete(key: string) {
		this.objects.delete(key);
	}

	async getSignedUploadUrl(): Promise<never> {
		throw new Error("not used");
	}

	getPublicUrl(key: string) {
		return `/${key}`;
	}
}

describe("storage key patterns", () => {
	it("treats a plain pattern as a prefix and * as any run of characters", () => {
		expect(matchesStoragePattern("frames/0001.webp", "frames/")).toBe(true);
		expect(matchesStoragePattern("products/frames/0001.webp", "frames/")).toBe(false);
		expect(matchesStoragePattern("products/chair-640.webp", "*-640.webp")).toBe(true);
		expect(matchesStoragePattern("products/chair-640.webp.png", "*-640.webp")).toBe(false);
		expect(matchesStoragePattern("a+b(1).png", "a+b(*).png")).toBe(true);
	});
});

describeEachDialect("media storage import", (dialect) => {
	let ctx: DialectTestContext;
	let storage: BucketStorage;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = new BucketStorage()
			.put("01HXREGISTERED.png", png(4, 4))
			.put("products/chair.png", png(640, 480))
			.put("products/chair-640.webp")
			.put("frames/0001.webp")
			.put("brochure.pdf")
			.put("notes.txt")
			.put("backups/emdash-backup-1.json")
			.put("transfers/op/manifest.json")
			.put("marketplace/plugin/1.0.0/backend.js");
		await new MediaRepository(ctx.db).create({
			filename: "registered.png",
			mimeType: "image/png",
			storageKey: "01HXREGISTERED.png",
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("lists only media objects that have no media row, without system objects", async () => {
		const result = await handleMediaStorageScan(ctx.db, storage, { limit: 100 });

		expect(result).toEqual({
			success: true,
			data: {
				items: [
					{
						key: "brochure.pdf",
						filename: "brochure.pdf",
						mimeType: "application/pdf",
						size: 10,
						directory: null,
					},
					expect.objectContaining({ key: "frames/0001.webp", directory: "frames" }),
					expect.objectContaining({ key: "products/chair-640.webp", directory: "products" }),
					expect.objectContaining({ key: "products/chair.png", mimeType: "image/png" }),
				],
				scannedCount: 9,
				nextCursor: undefined,
			},
		});
	});

	it("leaves out excluded prefixes and patterns", async () => {
		const result = await handleMediaStorageScan(ctx.db, storage, {
			exclude: ["frames/", "*-640.webp"],
		});
		expect(result.success && result.data.items.map((item) => item.key)).toEqual([
			"brochure.pdf",
			"products/chair.png",
		]);
	});

	it("registers files with type, size, dimensions and a folder named after their path, once", async () => {
		const keys = ["products/chair.png", "products/chair-640.webp", "brochure.pdf"];

		const first = await handleMediaStorageImport(ctx.db, storage, {
			keys,
			folder: { mode: "path" },
			exclude: ["*-640.webp"],
			authorId: "admin-1",
		});
		expect(first).toEqual({
			success: true,
			data: {
				imported: ["products/chair.png", "brochure.pdf"],
				skipped: [{ key: "products/chair-640.webp", reason: "excluded" }],
			},
		});

		const second = await handleMediaStorageImport(ctx.db, storage, {
			keys,
			folder: { mode: "path" },
		});
		expect(second.success && second.data.imported).toEqual(["products/chair-640.webp"]);
		expect(second.success && second.data.skipped).toEqual([
			{ key: "products/chair.png", reason: "registered" },
			{ key: "brochure.pdf", reason: "registered" },
		]);

		const rows = await ctx.db
			.selectFrom("media")
			.leftJoin("media_folders", "media_folders.id", "media.folder_id")
			.select([
				"media.storage_key",
				"media.filename",
				"media.mime_type",
				"media.size",
				"media.width",
				"media.height",
				"media.status",
				"media_folders.name as folder",
			])
			.where("media.storage_key", "!=", "01HXREGISTERED.png")
			.orderBy("media.storage_key")
			.execute();
		expect(rows).toEqual([
			expect.objectContaining({
				storage_key: "brochure.pdf",
				mime_type: "application/pdf",
				size: 10,
				folder: null,
			}),
			expect.objectContaining({ storage_key: "products/chair-640.webp", folder: "products" }),
			{
				storage_key: "products/chair.png",
				filename: "chair.png",
				mime_type: "image/png",
				size: 33,
				width: 640,
				height: 480,
				status: "ready",
				folder: "products",
			},
		]);
		expect(await ctx.db.selectFrom("media_folders").select("name").execute()).toEqual([
			{ name: "products" },
		]);

		const rescan = await handleMediaStorageScan(ctx.db, storage);
		expect(rescan.success && rescan.data.items.map((item) => item.key)).toEqual([
			"frames/0001.webp",
		]);
	});

	it("refuses system objects, non-media files and keys that are gone", async () => {
		const result = await handleMediaStorageImport(ctx.db, storage, {
			keys: [
				"backups/emdash-backup-1.json",
				"transfers/op/x.png",
				"notes.txt",
				"../x.png",
				"gone.png",
			],
			folder: { mode: "none" },
		});
		expect(result.success && result.data).toEqual({
			imported: [],
			skipped: [
				{ key: "backups/emdash-backup-1.json", reason: "unsupported" },
				{ key: "transfers/op/x.png", reason: "unsupported" },
				{ key: "notes.txt", reason: "unsupported" },
				{ key: "../x.png", reason: "unsupported" },
				{ key: "gone.png", reason: "missing" },
			],
		});
	});
});

describe("media storage import routes", () => {
	let ctx: DialectTestContext;
	let directory: string;

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");
		directory = await mkdtemp(join(tmpdir(), "emdash-storage-import-"));
		await mkdir(join(directory, "gallery"));
		await writeFile(join(directory, "gallery", "a.png"), png(2, 3));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		await rm(directory, { recursive: true, force: true });
	});

	function context(request: Request, role: (typeof Role)[keyof typeof Role]) {
		const storage = new LocalStorage({ directory, baseUrl: "/media" });
		return {
			request,
			params: {},
			locals: { emdash: { db: ctx.db, storage }, user: { id: "user-1", role } },
		} as unknown as Parameters<typeof GET>[0];
	}

	const importRequest = () =>
		new Request("http://localhost/_emdash/api/media/storage-import", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ keys: ["gallery/a.png"] }),
		});

	it("is for administrators only", async () => {
		const scan = new Request("http://localhost/_emdash/api/media/storage-import?prefix=gallery/");
		expect((await GET(context(scan, Role.EDITOR))).status).toBe(403);
		expect((await POST(context(importRequest(), Role.EDITOR))).status).toBe(403);
		expect(await ctx.db.selectFrom("media").select("id").execute()).toEqual([]);
	});

	it("scans a prefix of local storage and imports it into a folder", async () => {
		const scan = await GET(
			context(
				new Request("http://localhost/_emdash/api/media/storage-import?prefix=gallery/"),
				Role.ADMIN,
			),
		);
		expect(scan.status).toBe(200);
		await expect(scan.json()).resolves.toMatchObject({
			data: { items: [{ key: "gallery/a.png", directory: "gallery" }] },
		});

		const imported = await POST(context(importRequest(), Role.ADMIN));
		expect(imported.status).toBe(200);
		await expect(imported.json()).resolves.toMatchObject({
			data: { imported: ["gallery/a.png"], skipped: [] },
		});
		const invalid = await GET(
			context(
				new Request("http://localhost/_emdash/api/media/storage-import?prefix=../etc/"),
				Role.ADMIN,
			),
		);
		expect(invalid.status).toBe(400);
	});
});
