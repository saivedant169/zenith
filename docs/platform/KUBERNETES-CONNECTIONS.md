# Kubernetes connection credentials

Default Kubernetes sessions with `mode: kubeconfig_ref` require a full kubeconfig sealed in the owning workspace's Zenith vault. A bare token proves neither the API server nor its trust root and is refused by this path. Existing token-only references need to be replaced securely with a full configuration before verification or a default worker session can proceed.

The selected `current-context` must resolve to exactly one named context, cluster and user. That cluster's normalized HTTPS server and decoded `certificate-authority-data` bytes must match the current native connection's `server` and `caData`. Names must be unique within each kubeconfig list. The selected user may contain a static bearer token or an embedded client certificate and key pair. The worker uses the selected credential only after this binding succeeds.

File references, executable authentication plugins, external auth providers, proxy settings, impersonation, `tls-server-name` overrides and insecure TLS settings are refused. A server URL containing credentials, a query or a fragment is refused. Existing metadata and link-local endpoint restrictions still apply. Native namespace restrictions continue to control session scope; a kubeconfig namespace cannot widen that scope.

To migrate a token-only reference, obtain a full configuration for the same cluster through your existing secure credential process. Confirm its selected server and CA against the connection through a trusted channel, then store that configuration using the existing tenant vault interface. Keep credentials and private keys out of connection rows, manifests, audit text, issue descriptions and chat. The encrypted store's existing size limit applies. Re-run the normal connection verification; recording a successful verification remains a separate scoped operation and a revoked connection cannot be reactivated.

This check establishes a relationship between a tenant-sealed credential and its configured target. Verification still requires the existing namespaced API reads under that credential. It does not establish browser approvals, permissions for other operations, cluster-wide RBAC or complete managed Kubernetes deployment support. Direct development session APIs retain their existing explicit development behavior; this default vault policy does not grant them production authority. The product connection-to-native connection onboarding work remains separate.

## Teardown permissions

Teardown deletes only objects it can prove belong to the environment, and refuses (reporting the refs as uncertain) when it cannot prove what is absent. A namespaced deployer that can deploy and observe therefore still needs, for a teardown review to complete:

- cluster-scoped `get`, `list` and `watch` on `namespaces`, to discover namespaces Zenith created and confirm the environment's default namespace (`zenith-<environment>`) is absent;
- `get`, `list`, `watch` and `delete` in each allowlisted namespace on every kind Zenith manages there, including `horizontalpodautoscalers` (`autoscaling`) and `roles` and `rolebindings` (`rbac.authorization.k8s.io`). `create` on those is not needed for teardown.

Without them the review fails with a message naming the refs it could not review, for example `Namespace//*`. Nothing is deleted.
