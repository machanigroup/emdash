---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Adds the `multiSite` option to `emdash()`, so one deployment can serve several sites, grouped into organizations, each chosen by request hostname and kept in its own database and media storage.

Sites, their organizations, and their hostnames are stored in a separate control-plane database. Each site row names one of the databases and storage locations listed in the config, so a site can only use storage that the deployment's operator configured:

```ts
emdash({
	database: d1({ binding: "DB" }),
	storage: r2({ binding: "MEDIA" }),
	multiSite: {
		controlPlane: { binding: "CONTROL_DB" },
		databases: { "brand-a": { binding: "DB_BRAND_A" } },
		storages: { "brand-a": { binding: "MEDIA_BRAND_A" } },
		adminUrl: "https://admin.example.com",
	},
});
```

With `adminUrl` set, people sign in once on the admin host and manage every site they can reach, with the role their organization gives them on each site. The admin gains a site switcher and **Organizations** screens for sites, members, invitations, and per-site roles. **View Site** opens a site's own hostname signed in. Removing a member or changing their role applies on their next request to any site, including requests with their API tokens.

Each site runs its own migrations, plugins, scheduled publishing, and caches, and idle sites are released after `idleSiteTtlMs`. A hostname that no active site lists gets a 404. `@emdash-cms/auth` adds the `orgs:*` and `sites:manage` permissions these screens use. See [Multiple sites](https://docs.emdashcms.com/guides/multi-site/).

Deployments without `multiSite` are unchanged.
