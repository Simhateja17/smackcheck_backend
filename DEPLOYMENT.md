# Backend Deployment

Production API: `https://api.withcouture.me`
//
The backend deploys to the GCP VM through GitHub Actions on every push to `main`.

## Required GitHub Secrets

Add these in GitHub:

`Settings -> Secrets and variables -> Actions -> New repository secret`

| Secret | Value |
| --- | --- |
| `GCP_VM_HOST` | `35.192.10.30` |
| `GCP_VM_USER` | `globonexo_india` |
| `GCP_VM_SSH_KEY` | Private SSH key allowed to SSH into the VM |

## VM Requirements

The VM must already have:

- Backend repo at `/opt/backend`
- `.env` at `/opt/backend/.env`
- Node.js installed
- `backend.service` configured in `systemd`
- Nginx proxying `api.withcouture.me` to `127.0.0.1:3000`

Check the service:

```bash
sudo systemctl status backend --no-pager
curl -i https://api.withcouture.me/health
```

## What The Workflow Does

1. Installs dependencies with `npm ci`.
2. Checks JavaScript syntax with `node --check`.
3. SSHes into the VM.
4. Checks out the exact pushed commit in `/opt/backend`.
5. Runs `npm ci --omit=dev`.
6. Restarts `backend.service`.
7. Calls `https://api.withcouture.me/health`.
8. Rolls back to the previous commit if the health check fails.

## Manual Deploy Fallback

If GitHub Actions is unavailable:

```bash
cd /opt/backend
git fetch origin main
git checkout --force origin/main
npm ci --omit=dev
sudo systemctl restart backend
curl -i https://api.withcouture.me/health
```
