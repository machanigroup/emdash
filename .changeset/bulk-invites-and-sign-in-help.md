---
"@emdash-cms/admin": minor
---

Bulk invitations and a clearer sign-in page on a shared multi-site admin.

- **Add members** takes several email addresses at once (one per line, or separated by commas or semicolons) with one role, and reports each address as added, invited or failed. It then offers one editable invitation email for everyone: **Open in Gmail** (Bcc when there are several people), **Open in email app**, or **Copy message**. Each person's own invitation link is still listed when no email provider is configured.
- The sign-in page of a providers-only admin says what it is for ("Sign in to <site name>"), names the companies from `admin.loginLogos`, reminds people to use the account their invitation was sent to, and has a **Can't sign in?** section.
- Sign-in failures are explained by their error code in the admin's language: no invitation for that account, an invitation for a different address, an expired or used link, a removed account, a cancelled or timed-out sign-in.
