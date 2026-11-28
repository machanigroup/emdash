---
"emdash": patch
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Fixes seed apply failing with `Media usage collection lifecycle identity conflict` when a collection with the same slug was deleted earlier. Media usage bookkeeping left behind by a deleted collection no longer blocks a new collection, a seed, or media usage activation from claiming the slug, and a late usage refresh no longer recreates bookkeeping for a collection that is gone.

Adds Import from storage to the Media library for administrators. It lists files in the site's storage that have no media record, lets you leave out folders or patterns such as `frames/` or `*-640.webp`, and registers the chosen files with their type, size, image dimensions and, optionally, a folder named after their path. Importing the same files again does nothing. The new `GET` and `POST /_emdash/api/media/storage-import` endpoints require the new `media:import_storage` permission (Admin). Local storage now lists a prefix that ends in `/` as that folder's contents.
