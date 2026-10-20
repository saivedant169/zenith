#!/usr/bin/env bash
# Run the PROD-MAN-01 managed-substrate acceptance on a LOCAL kind + Calico cluster.
#
#   ZENITH_MAN_REGISTRY_IMAGE=<registry image@sha256:...> \
#   ZENITH_MAN_BUILDER_IMAGE=<kaniko-compatible builder image@sha256:...> \
#   scripts/k8s/managed-substrate-acceptance.sh
#
# What it builds, in order, and refuses at each step rather than improvising:
#   1. kind + Calico (scripts/k8s/kind-calico-up.sh; cluster zenith-life07-man01), so NetworkPolicy
#      is ENFORCED and the build namespace's egress policy actually binds
#   2. the platform baseline the managed substrate needs: namespaces, the operator RBAC
#      (deploy/zenith-managed/40-operator-rbac.yaml), the build namespace
#      (deploy/zenith-managed/50-build-namespace.yaml) with its egress policy extended by exactly one
#      rule: the registry below. Gateway API and cert-manager are NOT installed: the run uses the
#      substrate's `ingress` mode, so per-environment TLS/Gateway automation is out of scope here.
#   3. a registry (the image you pin) in namespace zenith-registry, published on a NodePort. Its
#      address is <kind node IP>:30500, written to every node's containerd as a plain-http host so the
#      kubelet can pull what the builder pushed. The builder pushes to the same address (--insecure).
#   4. the operator credential: a short-lived ServiceAccount token for zenith-operator, written to a
#      0600 file, then SEALED INTO THE PLATFORM VAULT SCOPE by scripts/managed/seed-platform-vault.ts
#      (the same operator tool a real deployment uses). The substrate reads it from there; no test
#      port is injected.
#   5. tests/providers/zenith/managed-kind.test.ts with ZENITH_MANAGED_* pointing at that cluster.
#
# You supply the two images because a registry and a build toolchain are choices the operator records,
# and this repository does not pin digests it has not read from a registry. Both must be pinned by
# sha256 digest or the script refuses.
#
# The cluster is deleted at the end unless ZENITH_K8S_KEEP=1. Evidence (JSON, no token, no kubeconfig,
# no server address) goes to $ZENITH_K8S_EVIDENCE_OUT (default ./.data-k8s-evidence).
#
# What this does NOT establish (live hosted acceptance is deferred): behaviour of a managed cloud
# cluster, cloud load balancers, DNS, ACME, a production registry, a production CNI, or any
# paying tenant.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/k8s/images.env
. "$here/images.env"
# shellcheck source=scripts/k8s/lib.sh
. "$here/lib.sh"

export ZENITH_KIND_CLUSTER_NAME="${ZENITH_KIND_CLUSTER_NAME:-zenith-life07-man01}"
name="$(k8s_cluster_name)"
k8s_require kind kubectl docker npx node

pinned='@sha256:[a-f0-9]{64}$'
registry_image="${ZENITH_MAN_REGISTRY_IMAGE:-}"
builder_image="${ZENITH_MAN_BUILDER_IMAGE:-}"
[[ "$registry_image" =~ $pinned ]] || k8s_die "set ZENITH_MAN_REGISTRY_IMAGE to a pinned image for the registry, using its sha256 digest" 2
[[ "$builder_image" =~ $pinned ]] || k8s_die "set ZENITH_MAN_BUILDER_IMAGE to a pinned image for the builder, using its sha256 digest" 2

evidence_dir="${ZENITH_K8S_EVIDENCE_OUT:-$repo/.data-k8s-evidence}"
mkdir -p "$evidence_dir"
export ZENITH_K8S_WORKDIR="${ZENITH_K8S_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/zenith-life07.XXXXXX")}"

cleanup() {
  local code=$?
  if [ "${ZENITH_K8S_KEEP:-0}" != "1" ]; then
    "$here/kind-calico-down.sh" || echo "warning: kind-calico-down.sh failed; remove cluster $name by hand" >&2
  fi
  exit "$code"
}
trap cleanup EXIT

"$here/kind-calico-up.sh"
export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
k8s_check_skew

echo "applying the platform baseline (namespaces, operator RBAC, build namespace)"
kubectl apply -f "$repo/deploy/zenith-managed/00-namespaces.yaml"
kubectl apply -f "$repo/deploy/zenith-managed/40-operator-rbac.yaml"
# Onboarding creates each tenant's operator RBAC through the bootstrap identity (placeholder, applied only to this
# disposable cluster); tenant sessions then use only the per-tenant operator identity it seals into the vault.
kubectl apply -f "$repo/deploy/zenith-managed/optional/41-tenant-bootstrap-rbac.yaml"
kubectl apply -f "$repo/deploy/zenith-managed/50-build-namespace.yaml"

echo "starting the registry"
kubectl create namespace zenith-registry --dry-run=client -o yaml | kubectl apply -f -
cat <<YAML | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: registry, namespace: zenith-registry }
spec:
  replicas: 1
  selector: { matchLabels: { app: registry } }
  template:
    metadata: { labels: { app: registry } }
    spec:
      containers:
        - name: registry
          image: ${registry_image}
          ports: [{ containerPort: 5000 }]
---
apiVersion: v1
kind: Service
metadata: { name: registry, namespace: zenith-registry }
spec:
  type: NodePort
  selector: { app: registry }
  ports: [{ port: 5000, targetPort: 5000, nodePort: 30500 }]
YAML
kubectl -n zenith-registry rollout status deployment/registry --timeout=300s

node_ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
[[ "$node_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || k8s_die "could not read a node InternalIP" 3
registry_host="${node_ip}:30500"

echo "teaching every node's containerd to pull ${registry_host} over plain http"
for node in $(kind get nodes --name "$name"); do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/${registry_host}"
  printf 'server = "http://%s"\n\n[host."http://%s"]\n  capabilities = ["pull", "resolve"]\n' "$registry_host" "$registry_host" \
    | docker exec -i "$node" sh -c "cat > /etc/containerd/certs.d/${registry_host}/hosts.toml"
done

echo "extending the build namespace egress policy by exactly the registry namespace"
cat <<YAML | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: zenith-build-egress, namespace: zenith-build }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
    # kube-proxy rewrites the NodePort to the registry pod before the policy is evaluated, so the rule names the
    # registry's own namespace and container port rather than the node address.
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: zenith-registry } } }]
      ports: [{ protocol: TCP, port: 5000 }]
YAML

echo "minting the bootstrap credential and sealing it into the platform vault scope"
secrets_dir="$ZENITH_K8S_WORKDIR/platform"
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"
umask 077
kubectl -n zenith-system create token zenith-bootstrap --duration=2h >"$secrets_dir/operator-token"
export ZENITH_DATA="$secrets_dir/data"
export ZENITH_STORE=file
export ZENITH_SECRET_KEY="${ZENITH_SECRET_KEY:-$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")}"
mkdir -p "$ZENITH_DATA"
(cd "$repo" && npx tsx scripts/managed/seed-platform-vault.ts --ref vault:zenith-managed/kubeconfig --file "$secrets_dir/operator-token")
rm -f "$secrets_dir/operator-token"

server="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')"
ca_data="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
[ -n "$server" ] && [ -n "$ca_data" ] || k8s_die "could not read the API server address and CA from the kubeconfig" 3

export ZENITH_TEST_MANAGED_KIND=1
export ZENITH_MANAGED_CLUSTER_SERVER="$server"
export ZENITH_MANAGED_CLUSTER_CA_DATA="$ca_data"
export ZENITH_MANAGED_KUBECONFIG_REF=vault:zenith-managed/kubeconfig
export ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX=vault:zenith-managed/operators
export ZENITH_MANAGED_APP_DOMAIN=apps.zenith.test
export ZENITH_MANAGED_GATEWAY_MODE=ingress
export ZENITH_MANAGED_INGRESS_CLASS=nginx
export ZENITH_MANAGED_REGISTRY="${registry_host}/zenith"
export ZENITH_MANAGED_BUILDER_IMAGE="$builder_image"
export ZENITH_MANAGED_BUILD_REGISTRY_INSECURE=1
export ZENITH_TEST_MANAGED_WORKLOAD_IMAGE="$ACCEPTANCE_IMAGE"
export ZENITH_TEST_MANAGED_EVIDENCE_OUT="$evidence_dir/managed-substrate-evidence.json"

cd "$repo"
npx vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json="$evidence_dir/managed-substrate-vitest-report.json" \
  tests/providers/zenith/managed-kind.test.ts

echo "evidence: $evidence_dir"
