/**
 * Organizations, sites, and members of a multi-site deployment
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

const BASE = `${API_BASE}/multisite`;

export interface SwitcherSite {
	id: string;
	name: string;
	orgId: string;
	orgName: string;
	role: number;
	url: string | null;
}

export interface OrganizationSummary {
	id: string;
	slug: string;
	name: string;
	role: number | null;
	siteCount: number;
	memberCount: number;
}

export interface OrganizationSite {
	id: string;
	orgId: string;
	slug: string;
	name: string;
	databaseRef: string;
	storageRef: string | null;
	status: "active" | "disabled";
	hostnames: string[];
	primaryHostname: string | null;
	url: string | null;
}

export interface OrganizationMember {
	userId: string;
	email: string | null;
	name: string | null;
	role: number;
	siteRoles: Array<{ siteId: string; role: number }>;
}

export interface OrganizationInvite {
	email: string;
	role: number;
	createdAt: string;
}

export interface OrganizationDetail {
	id: string;
	slug: string;
	name: string;
	viewerRole: number | null;
	canManageMembers: boolean;
	canManageSites: boolean;
	sites: OrganizationSite[];
	members: OrganizationMember[];
	invites: OrganizationInvite[];
}

export interface CreateSiteInput {
	slug: string;
	name: string;
	databaseRef: string;
	storageRef?: string | null;
	hostnames: string[];
}

export interface UpdateSiteInput {
	name?: string;
	status?: "active" | "disabled";
	hostnames?: string[];
}

function json(method: string, body?: unknown): RequestInit {
	return {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

export async function fetchSwitcherSites(): Promise<SwitcherSite[]> {
	const response = await apiFetch(`${BASE}/sites`);
	const data = await parseApiResponse<{ items: SwitcherSite[] }>(
		response,
		i18n._(msg`Failed to load sites`),
	);
	return data.items;
}

export async function fetchOrganizations(): Promise<{
	items: OrganizationSummary[];
	canCreate: boolean;
}> {
	const response = await apiFetch(`${BASE}/orgs`);
	return parseApiResponse(response, i18n._(msg`Failed to load organizations`));
}

export async function createOrganization(input: {
	slug: string;
	name: string;
}): Promise<{ id: string }> {
	const response = await apiFetch(`${BASE}/orgs`, json("POST", input));
	return parseApiResponse(response, i18n._(msg`Failed to create organization`));
}

export async function fetchOrganization(orgId: string): Promise<OrganizationDetail> {
	const response = await apiFetch(`${BASE}/orgs/${encodeURIComponent(orgId)}`);
	return parseApiResponse(response, i18n._(msg`Failed to load organization`));
}

export async function renameOrganization(orgId: string, name: string): Promise<void> {
	const response = await apiFetch(
		`${BASE}/orgs/${encodeURIComponent(orgId)}`,
		json("PATCH", { name }),
	);
	await parseApiResponse(response, i18n._(msg`Failed to rename organization`));
}

export async function fetchSiteRefs(): Promise<{ databases: string[]; storages: string[] }> {
	const response = await apiFetch(`${BASE}/refs`);
	return parseApiResponse(response, i18n._(msg`Failed to load site storage options`));
}

export async function createSite(orgId: string, input: CreateSiteInput): Promise<{ id: string }> {
	const response = await apiFetch(
		`${BASE}/orgs/${encodeURIComponent(orgId)}/sites`,
		json("POST", input),
	);
	return parseApiResponse(response, i18n._(msg`Failed to add site`));
}

export async function updateSite(siteId: string, input: UpdateSiteInput): Promise<void> {
	const response = await apiFetch(
		`${BASE}/sites/${encodeURIComponent(siteId)}`,
		json("PATCH", input),
	);
	await parseApiResponse(response, i18n._(msg`Failed to update site`));
}

export async function addMember(
	orgId: string,
	input: { email: string; role: number },
): Promise<{ status: "added" | "invited"; inviteUrl?: string }> {
	const response = await apiFetch(
		`${BASE}/orgs/${encodeURIComponent(orgId)}/members`,
		json("POST", input),
	);
	return parseApiResponse(response, i18n._(msg`Failed to add member`));
}

export async function updateMemberRole(orgId: string, userId: string, role: number): Promise<void> {
	const response = await apiFetch(
		`${BASE}/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
		json("PATCH", { role }),
	);
	await parseApiResponse(response, i18n._(msg`Failed to change role`));
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
	const response = await apiFetch(
		`${BASE}/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
		json("DELETE"),
	);
	await parseApiResponse(response, i18n._(msg`Failed to remove member`));
}

export async function cancelInvite(orgId: string, email: string): Promise<void> {
	const response = await apiFetch(
		`${BASE}/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(email)}`,
		json("DELETE"),
	);
	await parseApiResponse(response, i18n._(msg`Failed to cancel invitation`));
}

/** Sets a member's role on one site, or clears it with `null` to use their organization role. */
export async function setSiteRole(
	siteId: string,
	userId: string,
	role: number | null,
): Promise<void> {
	const path = `${BASE}/sites/${encodeURIComponent(siteId)}/roles/${encodeURIComponent(userId)}`;
	const response = await apiFetch(path, role === null ? json("DELETE") : json("PUT", { role }));
	await parseApiResponse(response, i18n._(msg`Failed to change site role`));
}

export interface SiteAccountImport {
	imported: number;
	linked: number;
	conflicts: string[];
}

/** Copies a site's existing accounts into the deployment and the site's organization. */
export async function importSiteAccounts(siteId: string): Promise<SiteAccountImport> {
	const response = await apiFetch(
		`${BASE}/sites/${encodeURIComponent(siteId)}/import-accounts`,
		json("POST"),
	);
	return parseApiResponse(response, i18n._(msg`Failed to import accounts`));
}

/** A link that opens `path` on the site's own hostname, signed in. */
export async function createSiteSignInLink(siteId: string, path = "/"): Promise<string> {
	const params = new URLSearchParams({ site: siteId, redirect: path });
	const response = await apiFetch(`${BASE}/handoff?${params}`, { method: "POST" });
	const data = await parseApiResponse<{ url: string }>(
		response,
		i18n._(msg`Failed to open the site`),
	);
	return data.url;
}

/** Reloads the admin on another site. */
export function switchToSite(siteId: string): void {
	window.location.assign(`/_emdash/admin?site=${encodeURIComponent(siteId)}`);
}
