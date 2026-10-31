# Security policy

This tool runs DDL against production databases, so reports about it matter.

**Please do not open a public issue for a vulnerability.** Report it privately through GitHub's private vulnerability reporting: https://github.com/naimebarati/typeorm-tenant-migrations/security/advisories/new (or the "Report a vulnerability" button under the repository's Security tab). Include the TypeORM, `pg`, PostgreSQL and Node versions, a minimal reproduction, and the impact you see.

Examples of what is in scope: SQL injection through tenant ids/schema names/table names, a way to make migrations run in the wrong schema, credentials appearing in reports/logs/CLI output, an advisory lock that outlives its run, `plan`/`status` writing to the database.

Known and documented, so not vulnerabilities by themselves: tenant data appearing in a database error message, and code execution through the config or migration files you point the tool at (both described in `docs/safety.md`).

There is no published security contact or support timeline yet; this file will be updated before the first stable release.
