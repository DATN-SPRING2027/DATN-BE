# Continuum AI Helm data-store authentication

The bundled MongoDB replica set and Redis cluster require credentials. Create
the Kubernetes Secrets in the release namespace before installing or upgrading
the chart. Supply secret material through the deployment's secret manager; do
not commit populated Secret manifests or pass credentials through Helm values.

## Required Secrets

`redis.auth.existingSecretName` defaults to `continuum-redis-auth`. It must
contain a `password` key with a high-entropy Redis password. The chart configures
the same password on every Redis Cluster node, uses it for the cluster bus,
probes, initialization job, backend services, and workers.

`mongodb.auth.existingSecretName` defaults to `continuum-mongodb-auth`. It must
contain these keys:

| Key | Used by |
| --- | --- |
| `root-username`, `root-password` | MongoDB's first-run administrator bootstrap and the replica-set initialization job. |
| `keyfile` | Shared internal authentication between MongoDB replica-set members. Use a strong unique keyfile accepted by MongoDB. |
| `application-username`, `application-password` | The restricted application account created by the initialization job. |
| `application-uri` | Authenticated replica-set URI injected into each backend service. Its credentials must match the application username and password above, URL-encode special characters, use `authSource=admin`, and name `replicaSet=rs0`. |

The initialization job grants the application account `readWrite` only on the
database names in `services.*.database`. It refuses to use the root identity as
the application identity. Keep the root credential out of backend service
containers.

When using an external MongoDB deployment, set `application-uri` to that
deployment's authenticated URI and set `mongodb.enabled=false` to omit the
bundled replica set. The former `mongodb.uri` Helm value is no longer used, so
credentials stay in a Secret rather than Helm release values.

## Existing MongoDB installations

Do not apply the authenticated chart to an existing unauthenticated replica set
without a planned maintenance migration. `MONGO_INITDB_ROOT_USERNAME` and
`MONGO_INITDB_ROOT_PASSWORD` are first-run inputs; the MongoDB image does not
create an administrator in a non-empty persistent data directory. Before the
chart restarts existing members with the keyfile, take and verify a backup,
create the administrator and restricted application user on the current replica
set, and follow MongoDB's replica-set keyfile rollout procedure. Then upgrade
the chart and verify authenticated service connectivity before restoring
traffic. The chart does not delete or reinitialize existing PVCs.

## Existing Redis clusters

The authenticated Redis configuration is intended for a new cluster. Plan a
maintenance window before upgrading an existing unauthenticated cluster: every
Redis node and every backend/worker client must use the same Secret password
during the transition. Preserve the Redis PVCs, then verify the cluster is
healthy and application queue traffic has resumed before restoring normal
traffic. Do not rotate the Redis password on only a subset of nodes or clients.

Changing either Secret does not automatically restart its consumers. Restart
the affected workloads after rotating credentials, and verify Redis Cluster
peer authentication and MongoDB replica-set health before restoring traffic.
