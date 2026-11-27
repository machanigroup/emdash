---
"emdash": minor
"@emdash-cms/plugin-audit-log": minor
---

The `content:afterPublish`, `content:afterUnpublish`, `content:afterSchedule`, `content:afterUnschedule` and `content:afterRestore` hook events now include `actor` (`{ id, role }`) when a signed-in user or API token made the change. Scheduled publishing and other system changes leave it out, as before.

The audit log plugin uses it to record publishing, unpublishing, scheduling and restores from the trash, alongside saves, deletions and uploads. Its **Audit History** page now shows who made each change, by name or email, and the entry's title; the Recent Activity widget shows who as well. The plugin now declares the `users:read` capability to look up those names, so sites that review plugin capabilities will see it requested.
