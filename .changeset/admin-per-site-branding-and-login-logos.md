---
"emdash": minor
"@emdash-cms/admin": minor
---

Brands each site of a shared multi-site admin with its own name and logo, and adds an `admin.loginLogos` option.

- On a shared admin, the site being managed now shows its saved Site Title and Logo (Settings → General) in place of the deployment-wide `admin.siteName` and `admin.logo`. Sites without a saved title or logo keep the deployment's branding. Single-site admins are unchanged.
- `admin.loginLogos` takes a list of `{ src, name }`. The sign-in page then shows each logo in turn, crossfading, in place of `admin.logo`. With reduced motion, the first logo stays still.
