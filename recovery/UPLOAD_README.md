# Backend recovery update — 14 November 2026; not deployed

Target: `harrisovcov1/JIGCOIN-backend`, existing `main` baseline
`ab024961bc7637bbeb80a3d9a9fac03bb18530da`. Render service `jigcoin-api` has
Auto-Deploy **Off**, as confirmed by the owner's saved-settings screenshot.

This update archive contains replacement/new source files with their relative
paths. Extract it before uploading. Upload the extracted files and directories
to the existing repository root; do not upload the ZIP itself or delete the
existing repository. Unchanged files remain in GitHub.

The backend and frontend archives are separate. Uploading the frontend may
trigger its Cloudflare deployment, so stage that only after the backend and its
database migration are ready. A GitHub upload alone does not apply SQL.

For the prepared backend release, use build command `npm ci`, start command
`node index.js`, and keep automatic migrations disabled (`AUTO_MIGRATE=0`).
The included npm lock file fixes the dependency tree used for the local tests.

The owner has already applied the V3 checked SQL installer successfully: all
seven checks passed at 00:18 UTC on 14 November. No SQL rerun is needed for this
upload. The included installer and migration are retained as source records.

Upload the extracted contents at the root of the existing backend repository on
main. Use commit message: "Add guarded Monetag rewards and recovery controls".
Keep Render Auto-Deploy Off and perform the deployment as a separate step after
confirming saved environment settings and build command. A successful GitHub
commit does not mean the Render backend has been updated.

Before manually deploying, verify saved recovery controls and the Render runtime
database role. Initial deployment keeps maintenance enabled and rewards disabled.
The private Monetag secret and provider callback are configured later directly in
the hosting/provider accounts. The exact order and remaining checks are in
`MONETAG_SETUP.md`. Do not activate rewards or customer payments merely because
an upload/build succeeds.

This archive supersedes JIGCOIN_backend_recovery_update_20261113.zip.

No database backup, customer data, account secret, `.env`, dependencies directory
or Git history is included. The manifest records each included source file's
SHA-256 for comparison. All prior account/payment/referral limitations in
`RECOVERY.md` still apply. These are recovery files, not a completed public launch.
