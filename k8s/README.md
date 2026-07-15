# Kubernetes live configuration

These manifests mirror the live `sgula.edi-it.com` deployment in the `pxinf`
cluster, namespace `sgula-site`.

The live app serves `/`, `/admin`, and `/api/*` from the `sgula-api` service on
port 3000. The API deployment mounts `sgula-admin-ui-overlay` over
`/app/public/admin.html` and `/app/public/style.css`; `kustomization.yaml`
generates that ConfigMap from the source files in `public/`.

Do not commit real values for `sgula-api-secrets`. The live secret already
exists in the cluster and contains `ADMIN_PASSWORD` and `SESSION_SECRET`.
