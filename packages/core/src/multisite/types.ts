import type { Generated } from "kysely";

export interface OrganizationTable {
	id: string;
	slug: string;
	name: string;
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export type SiteStatus = "active" | "disabled";

export interface SiteTable {
	id: string;
	org_id: string;
	slug: string;
	name: string;
	database_ref: string;
	storage_ref: string | null;
	status: SiteStatus;
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface SiteHostTable {
	hostname: string;
	site_id: string;
	is_primary: Generated<number>;
}

export interface OrgMemberTable {
	org_id: string;
	user_id: string;
	role: number;
	created_at: Generated<string>;
}

export interface SiteRoleOverrideTable {
	site_id: string;
	user_id: string;
	role: number;
}

/** Tables in the control-plane database, which is separate from every site database. */
export interface ControlPlaneDatabase {
	_emdash_orgs: OrganizationTable;
	_emdash_sites: SiteTable;
	_emdash_site_hosts: SiteHostTable;
	_emdash_org_members: OrgMemberTable;
	_emdash_site_role_overrides: SiteRoleOverrideTable;
}

export interface Organization {
	id: string;
	slug: string;
	name: string;
}

export interface Site {
	id: string;
	orgId: string;
	slug: string;
	name: string;
	databaseRef: string;
	storageRef: string | null;
	status: SiteStatus;
}
