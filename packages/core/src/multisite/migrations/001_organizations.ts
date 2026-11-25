import type { Kysely } from "kysely";

import { currentTimestamp } from "../../database/dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_orgs")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text", (col) => col.notNull().unique())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createTable("_emdash_sites")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("org_id", "text", (col) =>
			col.notNull().references("_emdash_orgs.id").onDelete("cascade"),
		)
		.addColumn("slug", "text", (col) => col.notNull())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("database_ref", "text", (col) => col.notNull())
		.addColumn("storage_ref", "text")
		.addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
		.addColumn("created_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("uq_emdash_sites_org_slug", ["org_id", "slug"])
		.execute();
	await db.schema
		.createIndex("idx_sites_org_id")
		.ifNotExists()
		.on("_emdash_sites")
		.column("org_id")
		.execute();

	await db.schema
		.createTable("_emdash_site_hosts")
		.ifNotExists()
		.addColumn("hostname", "text", (col) => col.primaryKey())
		.addColumn("site_id", "text", (col) =>
			col.notNull().references("_emdash_sites.id").onDelete("cascade"),
		)
		.addColumn("is_primary", "integer", (col) => col.notNull().defaultTo(0))
		.execute();
	await db.schema
		.createIndex("idx_site_hosts_site_id")
		.ifNotExists()
		.on("_emdash_site_hosts")
		.column("site_id")
		.execute();

	await db.schema
		.createTable("_emdash_org_members")
		.ifNotExists()
		.addColumn("org_id", "text", (col) =>
			col.notNull().references("_emdash_orgs.id").onDelete("cascade"),
		)
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("pk_emdash_org_members", ["org_id", "user_id"])
		.execute();
	await db.schema
		.createIndex("idx_org_members_user_id")
		.ifNotExists()
		.on("_emdash_org_members")
		.column("user_id")
		.execute();

	await db.schema
		.createTable("_emdash_site_role_overrides")
		.ifNotExists()
		.addColumn("site_id", "text", (col) =>
			col.notNull().references("_emdash_sites.id").onDelete("cascade"),
		)
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("role", "integer", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_emdash_site_role_overrides", ["site_id", "user_id"])
		.execute();
	await db.schema
		.createIndex("idx_site_role_overrides_user_id")
		.ifNotExists()
		.on("_emdash_site_role_overrides")
		.column("user_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_site_role_overrides").ifExists().execute();
	await db.schema.dropTable("_emdash_org_members").ifExists().execute();
	await db.schema.dropTable("_emdash_site_hosts").ifExists().execute();
	await db.schema.dropTable("_emdash_sites").ifExists().execute();
	await db.schema.dropTable("_emdash_orgs").ifExists().execute();
}
