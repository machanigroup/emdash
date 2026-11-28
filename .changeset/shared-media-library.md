---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a shared media library to multi-site deployments. On the shared admin, a person who can reach more than one site now sees each of those sites as a source in the Media library and in the media picker, and can pick an image from another site's library to use on the site they are managing. People who can reach one site see the library as before.

Other sites' media is read-only: it can be browsed and picked, not uploaded to, edited, or deleted. A picked item is stored as an external image with its absolute public URL, so it renders on the current site without a copy in that site's library. Listing a site's media takes `media:read` on that site, checked on the server; a site the person can't reach answers as not found. The new routes are `GET /_emdash/api/multisite/media-sources` and `GET /_emdash/api/multisite/sites/:siteId/media`, which answer on the shared admin host only.

A site's media gets its absolute URL from its storage's public URL, or from the site's primary hostname. A site with neither can't share its media until it gets one.
