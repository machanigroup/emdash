---
"emdash": minor
---

Adds the `multiSite` option to `emdash()`, so one deployment can serve several sites, each chosen by request hostname and kept in its own database and media storage.

Sites, their organizations, and their hostnames are stored in a separate control-plane database. Each site row names one of the databases and storage locations listed in the config, so a site can only use storage that the deployment's operator configured:

```ts
emdash({
	database: d1({ binding: "DB" }),
	storage: r2({ binding: "MEDIA" }),
	multiSite: {
		controlPlane: { binding: "CONTROL_DB" },
		databases: { "brand-a": { binding: "DB_BRAND_A" } },
		storages: { "brand-a": { binding: "MEDIA_BRAND_A" } },
	},
});
```

Each site runs its own migrations, plugins, scheduled publishing, and caches. A hostname that no active site lists gets a 404. On Cloudflare, `runScheduledTasks()` runs scheduled work for every active site. Sites other than the one using the `default` database and storage skip the object cache for now.

Deployments without `multiSite` are unchanged.
