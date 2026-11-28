---
"@emdash-cms/admin": patch
"emdash": patch
---

Shows each site in the multi-site switcher with its logo, name, and domain, and names an organization only when that adds information.

- Each row shows the logo saved in the site's Settings → General on a square tile, or the site's initial when it has no logo or the logo fails to load.
- An organization with one site of the same name no longer appears as a heading above that site, so the name shows once. Organizations with several sites, or whose site has a different name, keep their heading.
- `GET /_emdash/api/multisite/sites` now returns a `logoUrl` for each site: the logo's absolute public URL, or `null`. To build it, the route reads each listed site's settings from that site's database.
