import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_site_handoffs")
		.ifNotExists()
		.addColumn("token_hash", "text", (col) => col.primaryKey())
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("site_id", "text", (col) =>
			col.notNull().references("_emdash_sites.id").onDelete("cascade"),
		)
		.addColumn("expires_at", "text", (col) => col.notNull())
		.execute();
	await db.schema
		.createIndex("idx_site_handoffs_site_id")
		.ifNotExists()
		.on("_emdash_site_handoffs")
		.column("site_id")
		.execute();
	await db.schema
		.createIndex("idx_site_handoffs_expires_at")
		.ifNotExists()
		.on("_emdash_site_handoffs")
		.column("expires_at")
		.execute();

	await db.schema
		.createTable("_emdash_org_invites")
		.ifNotExists()
		.addColumn("org_id", "text", (col) =>
			col.notNull().references("_emdash_orgs.id").onDelete("cascade"),
		)
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("invited_by", "text")
		.addColumn("created_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_emdash_org_invites", ["org_id", "email"])
		.execute();
	await db.schema
		.createIndex("idx_org_invites_email")
		.ifNotExists()
		.on("_emdash_org_invites")
		.column("email")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_org_invites").ifExists().execute();
	await db.schema.dropTable("_emdash_site_handoffs").ifExists().execute();
}
