---
"@emdash-cms/plugin-webhook-notifier": minor
---

Sends `content:publish` and `content:unpublish` webhooks, and adds a **Publishing only** choice under **Events to Send** that sends publishing, unpublishing and deletion but not saves. Use it to rebuild a static site when what it shows changes, without a build for every draft save or autosave.

Sites set to **All events** or **Content changes only** now also receive the two new events.
