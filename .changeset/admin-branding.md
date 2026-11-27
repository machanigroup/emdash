---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds `admin.accentColor`, a hex colour that recolours the admin's primary buttons, brand fill and links in light and dark mode:

```js
emdash({
	admin: { logo: "/brand/logo.svg", siteName: "Acme", accentColor: "#115b78" },
});
```

On a multi-site admin host, a configured `admin.logo` now shows at a readable size in the site switcher (28px high, up to 80px wide), shrinking back to an icon in the collapsed sidebar. The first-login welcome there explains that access comes from organizations, sends administrators to **Organizations → Members** to invite people, and mentions the preview beside the editor.
