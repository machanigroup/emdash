---
"emdash": patch
---

On a multi-site deployment's shared admin host, `multiSite.signInDomains` now only decides who can create the first account, which becomes the deployment Admin. After that, signing in creates an account only for someone with a pending organization invitation, from any email domain. Anyone else is refused, including people from a sign-in domain, so being in the company's Google Workspace no longer gets someone into the CMS.

Accounts that already exist keep working. To remove an account created under the old rule, disable the user.
