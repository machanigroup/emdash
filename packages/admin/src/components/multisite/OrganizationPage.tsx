/**
 * One organization of a multi-site deployment: its sites, members, pending
 * invitations, and members' roles on individual sites.
 */

import {
	Badge,
	Banner,
	Button,
	Input,
	InputArea,
	LayerDialog,
	LinkButton,
	Loader,
	Select,
	Switch,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowSquareOut,
	EnvelopeSimple,
	Pencil,
	Plus,
	Trash,
	UserGear,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	addMember,
	cancelInvite,
	createSite,
	createSiteSignInLink,
	fetchOrganization,
	fetchSiteRefs,
	importSiteAccounts,
	removeMember,
	renameOrganization,
	setSiteRole,
	switchToSite,
	updateMemberRole,
	updateSite,
	type OrganizationDetail,
	type OrganizationMember,
	type OrganizationSite,
} from "../../lib/api";
import { useBreadcrumbLabel } from "../AdminBreadcrumbs.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { DialogError, getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "../settings/SettingsLayout.js";
import { useRolesConfig } from "../users/useRolesConfig.js";
import { gmailComposeUrl, mailtoUrl, parseEmailList, type InviteResult } from "./invite-email.js";
import { slugFromName } from "./slug.js";

const ORG_ROLE_VALUE = "org";
const HOSTNAME_SEPARATORS = /[\s,]+/;

function parseHostnames(text: string): string[] {
	return text
		.split(HOSTNAME_SEPARATORS)
		.map((hostname) => hostname.trim().toLowerCase())
		.filter(Boolean);
}

function useOrgQueryKey(orgId: string) {
	return ["multisite", "org", orgId] as const;
}

/** Opens a site's own pages signed in, in a new tab. */
function useOpenSite() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	return async (site: OrganizationSite) => {
		const tab = window.open("about:blank", "_blank");
		try {
			const url = await createSiteSignInLink(site.id);
			if (tab) {
				tab.opener = null;
				tab.location.href = url;
			} else {
				window.location.assign(url);
			}
		} catch (error) {
			tab?.close();
			toastManager.add({
				title: t`Failed to open the site`,
				description: error instanceof Error ? error.message : undefined,
				variant: "error",
				timeout: 3000,
			});
		}
	};
}

export function OrganizationPage({ orgId }: { orgId: string }) {
	const { t } = useLingui();
	const queryKey = useOrgQueryKey(orgId);
	const {
		data: org,
		isLoading,
		error,
	} = useQuery({
		queryKey,
		queryFn: () => fetchOrganization(orgId),
	});
	const [renaming, setRenaming] = React.useState(false);
	useBreadcrumbLabel(org?.name ?? (isLoading ? undefined : t`Organization`));

	if (isLoading) {
		return (
			<div role="status" className="flex items-center gap-2 text-sm text-kumo-subtle">
				<Loader size="sm" />
				<span>{t`Loading...`}</span>
			</div>
		);
	}
	if (error || !org) {
		return (
			<Banner
				variant="error"
				title={t`Failed to load organization`}
				description={error instanceof Error ? error.message : undefined}
				role="alert"
			/>
		);
	}

	return (
		<SettingsFrame
			title={org.name}
			description={t`A member's role here applies to every site in the organization, unless a site gives them a different role.`}
			actions={
				org.canManageMembers ? (
					<Button variant="secondary" icon={<Pencil />} onClick={() => setRenaming(true)}>
						{t`Rename`}
					</Button>
				) : undefined
			}
		>
			<div className="grid gap-8">
				<SitesSection org={org} />
				<MembersSection org={org} />
				{org.canManageMembers && org.invites.length > 0 && <InvitesSection org={org} />}
			</div>
			<RenameDialog org={org} open={renaming} onClose={() => setRenaming(false)} />
		</SettingsFrame>
	);
}

function RenameDialog({
	org,
	open,
	onClose,
}: {
	org: OrganizationDetail;
	open: boolean;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [name, setName] = React.useState(org.name);
	const formId = React.useId();
	const mutation = useMutation({
		mutationFn: (next: string) => renameOrganization(org.id, next),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			onClose();
		},
	});
	React.useEffect(() => {
		if (open) {
			setName(org.name);
			mutation.reset();
		}
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens
	}, [open]);

	return (
		<LayerDialog.Root
			open={open}
			onOpenChange={(next) => !next && !mutation.isPending && onClose()}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Rename organization`}</LayerDialog.Title>
				<LayerDialog.Body>
					<form
						id={formId}
						noValidate
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (name.trim()) mutation.mutate(name.trim());
						}}
					>
						<Input
							label={t`Name`}
							value={name}
							required
							onChange={(e) => setName(e.target.value)}
						/>
						<DialogError message={getMutationError(mutation.error)} />
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action
						type="submit"
						form={formId}
						disabled={!name.trim() || name.trim() === org.name || mutation.isPending}
					>
						{mutation.isPending ? t`Saving...` : t`Save`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

function SitesSection({ org }: { org: OrganizationDetail }) {
	const { t } = useLingui();
	const openSite = useOpenSite();
	const [adding, setAdding] = React.useState(false);
	const [editing, setEditing] = React.useState<OrganizationSite | null>(null);

	return (
		<SettingsSection
			title={t`Sites`}
			actions={
				org.canManageSites ? (
					<Button icon={<Plus />} onClick={() => setAdding(true)}>
						{t`Add site`}
					</Button>
				) : undefined
			}
		>
			{org.sites.length > 0 ? (
				org.sites.map((site) => (
					<SettingRow key={site.id}>
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-sm font-medium">
									<span className="truncate">{site.name}</span>
									{site.status === "disabled" && <Badge variant="neutral">{t`Disabled`}</Badge>}
								</div>
								<div className="truncate text-sm text-kumo-subtle">
									{site.hostnames.length > 0 ? (
										<bdi dir="ltr">{site.hostnames.join(", ")}</bdi>
									) : (
										t`No domain yet`
									)}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
								{site.status === "active" && (
									<>
										<Button variant="secondary" size="sm" onClick={() => switchToSite(site.id)}>
											{t`Manage`}
										</Button>
										{site.url && (
											<Button
												variant="ghost"
												shape="square"
												aria-label={t`View ${site.name}`}
												onClick={() => void openSite(site)}
											>
												<ArrowSquareOut className="size-4 rtl:-scale-x-100" />
											</Button>
										)}
									</>
								)}
								{org.canManageSites && (
									<Button
										variant="ghost"
										shape="square"
										aria-label={t`Edit ${site.name}`}
										onClick={() => setEditing(site)}
									>
										<Pencil className="size-4" />
									</Button>
								)}
							</div>
						</div>
					</SettingRow>
				))
			) : (
				<SettingRow className="py-8 text-center text-sm text-kumo-subtle">
					{org.canManageSites
						? t`No sites yet. Add one to start publishing.`
						: t`No sites yet. A deployment Admin can add them.`}
				</SettingRow>
			)}
			{org.canManageSites && (
				<>
					<AddSiteDialog org={org} open={adding} onClose={() => setAdding(false)} />
					<EditSiteDialog org={org} site={editing} onClose={() => setEditing(null)} />
				</>
			)}
		</SettingsSection>
	);
}

function AddSiteDialog({
	org,
	open,
	onClose,
}: {
	org: OrganizationDetail;
	open: boolean;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const formId = React.useId();
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [slugEdited, setSlugEdited] = React.useState(false);
	const [hostnames, setHostnames] = React.useState("");
	const [databaseRef, setDatabaseRef] = React.useState("");
	const [storageRef, setStorageRef] = React.useState("default");
	const { data: refs } = useQuery({
		queryKey: ["multisite", "refs"],
		queryFn: fetchSiteRefs,
		enabled: open,
	});
	const mutation = useMutation({
		mutationFn: () =>
			createSite(org.id, {
				name: name.trim(),
				slug,
				hostnames: parseHostnames(hostnames),
				databaseRef,
				storageRef,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			toastManager.add({ title: t`Site added`, variant: "success", timeout: 3000 });
			onClose();
		},
	});
	React.useEffect(() => {
		if (!open) return;
		setName("");
		setSlug("");
		setSlugEdited(false);
		setHostnames("");
		setDatabaseRef("");
		setStorageRef("default");
		mutation.reset();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens
	}, [open]);

	const ready = name.trim() && slug && databaseRef;
	const databaseItems = Object.fromEntries((refs?.databases ?? []).map((ref) => [ref, ref]));
	const storageItems = Object.fromEntries((refs?.storages ?? []).map((ref) => [ref, ref]));

	return (
		<LayerDialog.Root
			open={open}
			onOpenChange={(next) => !next && !mutation.isPending && onClose()}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Add site`}</LayerDialog.Title>
				<LayerDialog.Description>
					{t`The site gets its own content and media, kept in the database and storage you choose. You can add its domain now or later.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<form
						id={formId}
						noValidate
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (ready && !mutation.isPending) mutation.mutate();
						}}
					>
						<Input
							label={t`Name`}
							value={name}
							required
							onChange={(event) => {
								setName(event.target.value);
								if (!slugEdited) setSlug(slugFromName(event.target.value));
							}}
						/>
						<Input
							dir="ltr"
							label={t`Slug`}
							value={slug}
							required
							onChange={(event) => {
								setSlugEdited(true);
								setSlug(event.target.value);
							}}
						/>
						<InputArea
							dir="ltr"
							label={t`Hostnames`}
							description={t`Optional. One per line; the first is the site's main address. Point each domain at this deployment.`}
							placeholder="www.example.com"
							value={hostnames}
							rows={3}
							onChange={(event) => setHostnames(event.target.value)}
						/>
						<Select
							label={t`Database`}
							value={databaseRef || null}
							onValueChange={(value) => value !== null && setDatabaseRef(String(value))}
							items={databaseItems}
						>
							{(refs?.databases ?? []).map((ref) => (
								<Select.Option key={ref} value={ref}>
									<bdi dir="ltr">{ref}</bdi>
								</Select.Option>
							))}
						</Select>
						<Select
							label={t`Media storage`}
							value={storageRef}
							onValueChange={(value) => value !== null && setStorageRef(String(value))}
							items={storageItems}
						>
							{(refs?.storages ?? []).map((ref) => (
								<Select.Option key={ref} value={ref}>
									<bdi dir="ltr">{ref}</bdi>
								</Select.Option>
							))}
						</Select>
						<DialogError message={getMutationError(mutation.error)} />
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={!ready || mutation.isPending}>
						{mutation.isPending ? t`Adding...` : t`Add site`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

function EditSiteDialog({
	org,
	site,
	onClose,
}: {
	org: OrganizationDetail;
	site: OrganizationSite | null;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const formId = React.useId();
	const [name, setName] = React.useState("");
	const [hostnames, setHostnames] = React.useState("");
	const [active, setActive] = React.useState(true);
	const toastManager = useKumoToastManager();
	const importMutation = useMutation({
		mutationFn: (siteId: string) => importSiteAccounts(siteId),
		onSuccess: ({ imported, linked, conflicts }) => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			toastManager.add({
				title: t`Imported ${imported} accounts, ${linked} already here`,
				description:
					conflicts.length > 0
						? t`Skipped because another account uses the email: ${conflicts.join(", ")}`
						: undefined,
				variant: conflicts.length > 0 ? "warning" : "success",
				timeout: 6000,
			});
		},
	});
	const mutation = useMutation({
		mutationFn: () => {
			if (!site) return Promise.resolve();
			return updateSite(site.id, {
				name: name.trim(),
				hostnames: parseHostnames(hostnames),
				status: active ? "active" : "disabled",
			});
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			onClose();
		},
	});
	React.useEffect(() => {
		if (!site) return;
		setName(site.name);
		setHostnames(site.hostnames.join("\n"));
		setActive(site.status === "active");
		mutation.reset();
		importMutation.reset();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- reset when another site opens
	}, [site]);

	return (
		<LayerDialog.Root
			open={site !== null}
			onOpenChange={(next) => !next && !mutation.isPending && onClose()}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Edit ${site?.name ?? ""}`}</LayerDialog.Title>
				<LayerDialog.Description>{t`Part of ${org.name}.`}</LayerDialog.Description>
				<LayerDialog.Body>
					<form
						id={formId}
						noValidate
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (name.trim()) mutation.mutate();
						}}
					>
						<Input
							label={t`Name`}
							value={name}
							required
							onChange={(e) => setName(e.target.value)}
						/>
						<InputArea
							dir="ltr"
							label={t`Hostnames`}
							description={t`One per line. The first is the site's main address.`}
							value={hostnames}
							rows={3}
							onChange={(event) => setHostnames(event.target.value)}
						/>
						<Switch label={t`Site is online`} checked={active} onCheckedChange={setActive} />
						{!active && (
							<p className="text-sm text-kumo-subtle">
								{t`A site that isn't online answers every request with "Site not found", and nobody can manage it until it is back online.`}
							</p>
						)}
						{site?.status === "active" && (
							<div className="grid gap-2 border-t border-kumo-line pt-4">
								<p className="text-sm text-kumo-subtle">
									{t`Did this site have its own accounts before it joined? Import them so those people can sign in here, with the roles they had on the site.`}
								</p>
								<Button
									variant="secondary"
									className="justify-self-start"
									disabled={importMutation.isPending}
									onClick={() => site && importMutation.mutate(site.id)}
								>
									{importMutation.isPending ? t`Importing...` : t`Import accounts`}
								</Button>
							</div>
						)}
						<DialogError message={getMutationError(mutation.error ?? importMutation.error)} />
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={mutation.isPending}>
						{mutation.isPending ? t`Saving...` : t`Save`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

function RoleSelect({
	label,
	value,
	onChange,
	disabled,
	allowOrgRole = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	allowOrgRole?: boolean;
}) {
	const { t } = useLingui();
	const { roles } = useRolesConfig();
	const items = Object.fromEntries([
		...(allowOrgRole ? [[ORG_ROLE_VALUE, t`Organization role`]] : []),
		...roles.map((role) => [String(role.value), role.label]),
	]);
	return (
		<Select
			size="sm"
			aria-label={label}
			value={value}
			onValueChange={(next) => next !== null && onChange(String(next))}
			items={items}
			disabled={disabled}
		>
			{allowOrgRole && <Select.Option value={ORG_ROLE_VALUE}>{t`Organization role`}</Select.Option>}
			{roles.map((role) => (
				<Select.Option key={role.value} value={String(role.value)}>
					{role.label}
				</Select.Option>
			))}
		</Select>
	);
}

function MembersSection({ org }: { org: OrganizationDetail }) {
	const { t } = useLingui();
	const { getRoleLabel } = useRolesConfig();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [adding, setAdding] = React.useState(false);
	const [removing, setRemoving] = React.useState<OrganizationMember | null>(null);
	const [siteRolesFor, setSiteRolesFor] = React.useState<OrganizationMember | null>(null);

	const roleMutation = useMutation({
		mutationFn: ({ userId, role }: { userId: string; role: number }) =>
			updateMemberRole(org.id, userId, role),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["multisite"] }),
		onError: (error) =>
			toastManager.add({
				title: t`Failed to change role`,
				description: error instanceof Error ? error.message : undefined,
				variant: "error",
				timeout: 4000,
			}),
	});
	const removeMutation = useMutation({
		mutationFn: (userId: string) => removeMember(org.id, userId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			setRemoving(null);
		},
	});

	return (
		<SettingsSection
			title={t`Members`}
			actions={
				org.canManageMembers ? (
					<Button icon={<Plus />} onClick={() => setAdding(true)}>
						{t`Add member`}
					</Button>
				) : undefined
			}
		>
			{org.members.map((member) => {
				const label = member.name || member.email || member.userId;
				return (
					<SettingRow key={member.userId}>
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="min-w-0">
								<div className="truncate text-sm font-medium">{label}</div>
								{member.email && (
									<div className="truncate text-sm text-kumo-subtle">
										<bdi dir="ltr">{member.email}</bdi>
									</div>
								)}
								{member.siteRoles.length > 0 && (
									<div className="text-sm text-kumo-subtle">
										{plural(member.siteRoles.length, {
											one: "Different role on # site",
											other: "Different role on # sites",
										})}
									</div>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
								{org.canManageMembers ? (
									<>
										<RoleSelect
											label={t`Role of ${label}`}
											value={String(member.role)}
											disabled={roleMutation.isPending}
											onChange={(value) =>
												roleMutation.mutate({ userId: member.userId, role: Number(value) })
											}
										/>
										{org.sites.length > 0 && (
											<Button
												variant="ghost"
												shape="square"
												aria-label={t`Site roles of ${label}`}
												onClick={() => setSiteRolesFor(member)}
											>
												<UserGear className="size-4" />
											</Button>
										)}
										<Button
											variant="ghost"
											shape="square"
											aria-label={t`Remove ${label}`}
											onClick={() => {
												removeMutation.reset();
												setRemoving(member);
											}}
										>
											<Trash className="size-4 text-kumo-danger" />
										</Button>
									</>
								) : (
									<Badge variant="neutral">{getRoleLabel(member.role)}</Badge>
								)}
							</div>
						</div>
					</SettingRow>
				);
			})}
			{org.canManageMembers && (
				<>
					<AddMemberDialog org={org} open={adding} onClose={() => setAdding(false)} />
					<SiteRolesDialog org={org} member={siteRolesFor} onClose={() => setSiteRolesFor(null)} />
					<ConfirmDialog
						open={removing !== null}
						onClose={() => setRemoving(null)}
						title={t`Remove member?`}
						description={t`${removing?.name || removing?.email || ""} loses access to every site in ${org.name}, including any API tokens they created there.`}
						confirmLabel={t`Remove`}
						pendingLabel={t`Removing...`}
						isPending={removeMutation.isPending}
						error={removeMutation.error}
						onConfirm={() => removing && removeMutation.mutate(removing.userId)}
					/>
				</>
			)}
		</SettingsSection>
	);
}

function AddMemberDialog({
	org,
	open,
	onClose,
}: {
	org: OrganizationDetail;
	open: boolean;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const formId = React.useId();
	const [emails, setEmails] = React.useState("");
	const [role, setRole] = React.useState("30");
	const [results, setResults] = React.useState<InviteResult[] | null>(null);
	const [subject, setSubject] = React.useState("");
	const [message, setMessage] = React.useState("");
	const [copied, setCopied] = React.useState<string | null>(null);
	const parsed = parseEmailList(emails);
	const adminUrl = `${window.location.origin}/_emdash/admin`;

	const mutation = useMutation({
		mutationFn: async () => {
			const done: InviteResult[] = [];
			for (const email of parsed.valid) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the order and the server's rate limits
					const { status, inviteUrl } = await addMember(org.id, { email, role: Number(role) });
					done.push({ email, status, inviteUrl });
				} catch (error) {
					done.push({
						email,
						status: "failed",
						error: getMutationError(error) ?? t`Couldn't add this address`,
					});
				}
			}
			return done;
		},
		onSuccess: (done) => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			setSubject(t`You're invited to ${org.name}'s website`);
			setMessage(
				t`Hello,

You've been invited to help manage ${org.name}'s website.

1. Go to ${adminUrl}
2. Choose "Sign in with Google" and use the email address this message was sent to.

If you have any trouble, reply to this email.`,
			);
			setResults(done);
		},
	});
	React.useEffect(() => {
		if (!open) return;
		setEmails("");
		setRole("30");
		setResults(null);
		setCopied(null);
		mutation.reset();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens
	}, [open]);

	const recipients = results?.filter((r) => r.status !== "failed").map((r) => r.email) ?? [];
	const copy = (text: string, key: string) =>
		void navigator.clipboard.writeText(text).then(() => setCopied(key));
	const statusLabel = (result: InviteResult) =>
		result.status === "added" ? t`Added` : result.status === "invited" ? t`Invited` : result.error;

	return (
		<LayerDialog.Root
			open={open}
			onOpenChange={(next) => !next && !mutation.isPending && onClose()}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{results ? t`Send the invitation` : t`Add members`}</LayerDialog.Title>
				<LayerDialog.Description>
					{results
						? t`Write the invitation once and send it to everyone from your own email. Each person signs in with Google using the address it was sent to.`
						: t`Add one address or many. People without an account are invited to create one and join ${org.name}.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					{results ? (
						<div className="grid gap-4">
							<ul className="grid gap-2" aria-label={t`Results`}>
								{results.map((result) => (
									<li
										key={result.email}
										className="grid gap-1 rounded-lg border border-kumo-line p-2.5"
									>
										<div className="flex items-center justify-between gap-3">
											<span dir="ltr" className="truncate text-sm">
												{result.email}
											</span>
											<Badge variant={result.status === "failed" ? "destructive" : "secondary"}>
												{statusLabel(result)}
											</Badge>
										</div>
										{result.inviteUrl && (
											<div className="flex items-center gap-2">
												<code
													dir="ltr"
													className="min-w-0 flex-1 truncate text-xs text-kumo-subtle"
												>
													{result.inviteUrl}
												</code>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => copy(result.inviteUrl!, result.email)}
												>
													{copied === result.email ? t`Copied` : t`Copy link`}
												</Button>
											</div>
										)}
									</li>
								))}
							</ul>
							{recipients.length > 0 && (
								<div className="grid gap-3">
									<Input
										label={t`Subject`}
										value={subject}
										onChange={(e) => setSubject(e.target.value)}
									/>
									<InputArea
										label={t`Message`}
										value={message}
										rows={8}
										onChange={(e) => setMessage(e.target.value)}
									/>
									<div className="flex flex-wrap gap-2">
										<LinkButton
											href={gmailComposeUrl(recipients, subject, message)}
											external
											variant="primary"
											icon={<EnvelopeSimple aria-hidden="true" />}
										>
											{t`Open in Gmail`}
										</LinkButton>
										<LinkButton href={mailtoUrl(recipients, subject, message)} variant="secondary">
											{t`Open in email app`}
										</LinkButton>
										<Button
											variant="secondary"
											onClick={() => copy(`${subject}\n\n${message}`, "message")}
										>
											{copied === "message" ? t`Copied` : t`Copy message`}
										</Button>
									</div>
								</div>
							)}
						</div>
					) : (
						<form
							id={formId}
							noValidate
							className="grid gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (parsed.valid.length && !parsed.invalid.length && !mutation.isPending)
									mutation.mutate();
							}}
						>
							<InputArea
								dir="ltr"
								label={t`Email addresses`}
								description={t`One per line, or separated by commas.`}
								value={emails}
								rows={4}
								required
								onChange={(event) => setEmails(event.target.value)}
								error={
									parsed.invalid.length
										? t`Not an email address: ${parsed.invalid.join(", ")}`
										: undefined
								}
							/>
							<div className="grid gap-1.5">
								<span className="text-sm font-medium">{t`Role`}</span>
								<RoleSelect label={t`Role`} value={role} onChange={setRole} />
							</div>
						</form>
					)}
				</LayerDialog.Body>
				{results ? (
					<LayerDialog.Actions dismissLabel={t`Done`}>
						<LayerDialog.Action
							key="add-more"
							onClick={() => {
								setResults(null);
								setEmails("");
								setCopied(null);
								mutation.reset();
							}}
						>
							{t`Add more`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				) : (
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action
							type="submit"
							form={formId}
							disabled={!parsed.valid.length || parsed.invalid.length > 0 || mutation.isPending}
						>
							{mutation.isPending
								? t`Adding...`
								: plural(parsed.valid.length, { one: "Add # member", other: "Add # members" })}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				)}
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

function SiteRolesDialog({
	org,
	member,
	onClose,
}: {
	org: OrganizationDetail;
	member: OrganizationMember | null;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: ({ siteId, role }: { siteId: string; role: number | null }) =>
			setSiteRole(siteId, member?.userId ?? "", role),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["multisite"] }),
	});
	const current = member
		? (org.members.find((candidate) => candidate.userId === member.userId) ?? member)
		: null;
	const label = current?.name || current?.email || "";

	return (
		<LayerDialog.Root
			open={member !== null}
			onOpenChange={(next) => !next && !mutation.isPending && onClose()}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Site roles of ${label}`}</LayerDialog.Title>
				<LayerDialog.Description>
					{t`Give ${label} a different role on a site, or keep their organization role.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<div className="grid gap-3">
						{org.sites.map((site) => {
							const override = current?.siteRoles.find((siteRole) => siteRole.siteId === site.id);
							return (
								<div key={site.id} className="flex items-center justify-between gap-3">
									<span className="truncate text-sm">{site.name}</span>
									<RoleSelect
										label={t`Role on ${site.name}`}
										allowOrgRole
										disabled={mutation.isPending}
										value={override ? String(override.role) : ORG_ROLE_VALUE}
										onChange={(value) =>
											mutation.mutate({
												siteId: site.id,
												role: value === ORG_ROLE_VALUE ? null : Number(value),
											})
										}
									/>
								</div>
							);
						})}
						<DialogError message={getMutationError(mutation.error)} />
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions>
					<LayerDialog.Action onClick={onClose}>{t`Done`}</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

function InvitesSection({ org }: { org: OrganizationDetail }) {
	const { t } = useLingui();
	const { getRoleLabel } = useRolesConfig();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (email: string) => cancelInvite(org.id, email),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["multisite"] }),
	});
	return (
		<SettingsSection
			title={t`Pending invitations`}
			description={t`These people join when they first sign in with the invited email.`}
		>
			{org.invites.map((invite) => (
				<SettingRow key={invite.email}>
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="truncate text-sm font-medium">
								<bdi dir="ltr">{invite.email}</bdi>
							</div>
							<div className="text-sm text-kumo-subtle">{getRoleLabel(invite.role)}</div>
						</div>
						<Button
							variant="ghost"
							size="sm"
							disabled={mutation.isPending}
							onClick={() => mutation.mutate(invite.email)}
						>
							{t`Cancel invitation`}
						</Button>
					</div>
				</SettingRow>
			))}
		</SettingsSection>
	);
}

export default OrganizationPage;
