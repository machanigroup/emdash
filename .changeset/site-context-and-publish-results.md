---
"@emdash-cms/admin": minor
"@emdash-cms/plugin-webhook-notifier": minor
---

Shows which site a settings page changes, and whether the live site answered a publish webhook.

- On the shared admin of a multi-site deployment, the Settings page, every settings sub-page, plugin settings pages and plugin admin pages (such as **Webhook Settings**) now show the current site's logo, name and domain above the title. Single-site admins are unchanged.
- **Webhook Settings** sends a test call when you save settings with a webhook URL and webhooks enabled, and shows the answer on the page, for example "svasahomes.com answered 200" or "401: token rejected". **Test Webhook** shows the same answer.
- When the webhook notifier sends publish webhooks, the content editor shows the result next to the Publish button: "Live on example.com" with a link to the entry, or "Site didn't answer (502)" with a **Retry** button that resends the publish webhook.
- The webhook notifier adds two private routes, `publish-status` and `publish-retry`, which need `content:publish_own`; resending another author's entry also needs an editor role. They return the webhook endpoint's host but never its full URL. The plugin declares a new `deliveries` storage index on `resourceId`, `event` and `timestamp`, which EmDash creates on startup.
