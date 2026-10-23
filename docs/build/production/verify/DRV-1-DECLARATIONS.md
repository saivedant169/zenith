# DRV-1 owner declarations: compiler pin and J6 build declaration

**Status: APPROVED by the owner on 2026-10-22, including running DRV-1 on hosted `ubuntu-24.04-arm` with Calico. Not yet run against kind.**
Prepared 2026-10-22 on the fork `saivedant169/zenith`. It covers the two inputs that
[DRV-1](DRV-1.md) needs from the owner: `DRV1_COMPILER_IMAGE` and the J6 build
declaration in `ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE`. The other DRV-1 inputs
are listed under "Still needed" and are not covered here.

## 1. Compiler pin (`DRV1_COMPILER_IMAGE`)

Proposed value for native ARM64:

    rust:1.99.0-alpine3.22@sha256:ba511babd167c72f478edbfa2461f5499a7e9639e9793705e8b8090382731198

- This is the official Docker image. Its recipe (`rust-lang/docker-rust`, `stable/alpine3.22/Dockerfile`) installs
  `musl-dev` and `gcc` on `alpine:3.22`. That gives `cc` and static musl libc with no package download, which
  `Dockerfile.fixture` requires because the build runs with `--network=none`.
- The digest is the linux/arm64 platform manifest, built 2026-10-01. It sits under index `sha256:c3a5ad77…bb3b`. The
  amd64 platform manifest is `sha256:e4693cd4f8e853454d5a576f6ef38166d0fa55161576d5883468a58267d1507c`, for an amd64
  leg. `1.99.1` was rejected: its current digest was rebuilt on 2026-10-21, inside the 2-week age rule.
- Size is 330 MiB compressed and 1.33 GB unpacked. It is used only for the host compile step. The J6 source build
  copies the resulting binary and never pulls the compiler.
- Checked on this Mac (native arm64 Docker) with the exact DRV-1 compile step:
  - `docker build --network=none --pull=false --platform linux/arm64 --target compile -f deploy/zenith-managed/build/Dockerfile.fixture`
    produced `/app`, 66,912 bytes, `ELF 64-bit LSB executable, ARM aarch64, statically linked, stripped`.
  - That is inside the driver's 64 B to 600 KiB window (`sourceBinary` in `scripts/release/drivers/source-build-fixture.ts`).
  - The owned build image and container were removed. The pulled base image remains local.
- Why not the alternatives:
  - The official `gcc` image is glibc-based. A static glibc build of the fixture is far larger and links NSS.
  - `alpine` and `golang:alpine` have no compiler.

## 2. J6 build declaration (`ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE`)

Write this file at run time, outside the checkout, as a regular file with mode 0600.
`scripts/release/drivers/github-fixture.ts` (`declaredProfile`) and `source-build-fixture.ts` keep only the
owner-controlled fields below. They replace these at run:
- `namespace` becomes `zb-<tenant key>` and `proxy.namespace` becomes `zp-<tenant key>`.
- `nodeIsolation.tenant` becomes the tenant key.
- `registryRepositoryRoot` and `proxy.destinations` become the owned registry `<ip>:5000`.

The placeholder values shown for those fields only have to pass the schema.

```json
{
  "registryRepositoryRoot": "localhost:5000/zenith-drv1-build",
  "config": {
    "namespace": "zb-replaced-by-driver",
    "builderImage": "<BUILDER_REF>@sha256:<filled at run, see 2.1>",
    "runtimeClass": "zenith-build-gvisor",
    "seccompProfile": "zenith-build.json",
    "appArmorProfile": "zenith-build",
    "nodeIsolation": {
      "tenant": "replaced-by-driver",
      "profileDigest": "897374eb4b9c19774a93cd50f56b07603968e066051bc3c8dc1b8097fe88db6e",
      "systemDaemonSets": ["kube-proxy", "calico-node"]
    },
    "proxy": {
      "namespace": "zp-replaced-by-driver",
      "ip": "10.96.200.10",
      "port": 3128,
      "image": "<PROXY_REF>@sha256:<filled at run, see 2.1>",
      "destinations": [{ "host": "replaced-by-driver", "ip": "172.18.0.250", "port": 5000, "tls": false }]
    },
    "timeoutSec": 1800
  }
}
```

There is no `pushSecret`. The driver refuses one for the ephemeral local registry.

Field rationale:
- **`runtimeClass`, `seccompProfile`, `appArmorProfile`:** these are the fixed values from the owner-approved
  [isolated-build profiles review](ISOLATED-BUILD-PROFILES-REVIEW.md) (2026-10-21).
- **`profileDigest`:** this was recomputed with `deploy/zenith-managed/build/review-profile.ts` over the committed
  profile files and equals the approved `897374eb…db6e`. The file hashes also match that review:
  - seccomp `15391af9…dd3b`
  - AppArmor `802290e2…2878`
  - RuntimeClass `104ba2f0…8359`

  The digest depends only on those three files.
- **`systemDaemonSets`:** these are the kube-system DaemonSets allowed on tenant build nodes. kind's `kube-proxy` and
  Calico's `calico-node` both tolerate all taints by default. This must match the CNI manifest the owner approves (see
  "Still needed"). If Cilium is chosen instead, use `["kube-proxy", "cilium", "cilium-envoy"]`.
- **`proxy.ip` and `proxy.port`:** `10.96.200.10` is an address in kind's default Service range (`10.96.0.0/16`) that no
  default Service uses. Port 3128 is the conventional proxy port inside the allowed 1024 to 65535 range. Confirm the
  address is unused on the fresh cluster before the run.
- **`timeoutSec`:** 1800 is the schema default and maximum.

### 2.1 Builder and proxy image pins (built at run, then filled in)

These images are built from repository Dockerfiles. Their digests exist only after a local build and push, so they
cannot be fixed in advance. Proposed inputs, all digest-pinned to linux/arm64 platform manifests, at least 2 weeks old:

| Build arg | Value |
|---|---|
| `GO_IMAGE` (Dockerfile.builder) | `golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414` (index pin already used by CI; multi-arch) |
| `BUILDKIT_IMAGE` (Dockerfile.builder) | `moby/buildkit:v0.34.0-rootless@sha256:a9c380801728257d27bada887d70b1237622398f0fe2c24f4aa5ffdd36188613` (v0.34.0, released 2026-10-07; v0.34.1 is too new) |
| `PYTHON_IMAGE` (Dockerfile.proxy) | `python:3.13-alpine3.22@sha256:a9b1e8cb5d25a3c62c0a248913331c9031fc0a45d97975aafe459d41bdfef36d` (`proxy.py` uses only the standard library) |

amd64 platform digests for a later amd64 leg:
- BuildKit `sha256:f9fad9251904053271e79f96b918e67f0750f34cd621f439b0c341b66ca31359`
- Python `sha256:7f7ee17311e0273954ffe76a7b84a2d8c8ecf16f9992e780e4d46c86175df431`

At run, build both with `--platform linux/arm64` and these build args, then push them to the run's owned local registry.
Write each resulting `@sha256:` reference into `builderImage` and `proxy.image`, and load them into kind. The driver
checks both references before admitting any build.

## 3. Recommendation on where to run

The profiles review leaves one question open: whether Docker Desktop's VM on this Mac has AppArmor. If it does not,
kubelet refuses the build pod and DRV-1 cannot pass here. GitHub-hosted `ubuntu-24.04-arm` runners are native arm64
Linux with AppArmor, and J2 now passes on them (run 39769374528). I recommend running DRV-1 there as a new
operated-gate option, using these declarations. That requires a workflow change, which I will make only after you
approve this draft.

## 4. Self-review

| Check | Result |
|---|---|
| Compiler pin syntax (`PINNED_IMAGE`), arm64, static, size window | Passed locally (see 1) |
| Declaration fields against `ConfigSchema` / `validateConfig` | A filled sample passed `readBuildProfiles` through `review-profile.ts`: namespace/proxy separation, no loopback or metadata destinations, unique destinations, tenant custody rules |
| Profile digest equals owner-approved review | Yes, `897374eb…db6e` |
| No credentials, `pushSecret` or private paths in this document | Yes |
| Image ages at least 2 weeks (image `created`, linux/arm64) | Rust 1.99.0 2026-10-01, BuildKit v0.34.0 2026-09-17, Go 1.27 2026-09-17, Python 3.13 2026-04-17 |

Not verified:
- AppArmor and seccomp loading, the gVisor runtime, and the CNI in a kind cluster.
- Builder and proxy builds.
- Any J6 probe.

## Still needed for DRV-1 (not in this draft; superseded for the hosted lane by the 2026-10-23 section below)

- **`DRV1_KIND_IMAGE`:** a kind node image with `runsc` (J14 `setup-kind.ts`), the seccomp file at
  `/var/lib/kubelet/seccomp/zenith-build.json` and the AppArmor profile loaded. Alternatively, a run-time install step
  on stock kind nodes.
- **`DRV1_CNI_MANIFEST`:** an enforcing CNI, for example Calico v3.33.0 (released 2026-10-01), with pod CIDR
  10.244.0.0/16 and digest-pinned images.
- **`DRV1_RUNTIME_MANIFEST`:** `deploy/zenith-managed/build/profiles/zenith-build-gvisor.runtimeclass.json`.
- **Witness and registry images:** as in DRV-1.md.

## How to approve

Reply "approve DRV-1 declarations", or name changes, for example a different compiler image, Cilium instead of Calico,
another proxy IP or port, or running on the Mac instead of hosted arm64.

## 2026-10-23 runtime change (owner decision): runc for disposable build verification

The declaration above is superseded in two fields for the `drv1-private-source` lane, which now runs on an ephemeral
single-tenant GitHub-hosted runner:
- `runtimeClass`: `zenith-build-runc` (was `zenith-build-gvisor`).
- `nodeIsolation.profileDigest`: `559c41027d4793561f860cc1ab5aaebd8dab04a2766a26961973ba1f1151de47` (was
  `897374eb…db6e`), recomputed with `review-profile.ts`'s method; seccomp and AppArmor hashes are unchanged, only the
  RuntimeClass manifest differs.
- Runtime selection: `DRV1_RUNTIME=runc` (`drv1-isolation.ts` creates `zenith-build-runc.runtimeclass.json`; there is no
  `DRV1_RUNTIME_MANIFEST` variable, the paths are fixed in the driver); no gVisor archive.

All other fields are unchanged. Reasoning, residual risk and the required independent security review are in
[ISOLATED-BUILD-PROFILES-REVIEW.md](ISOLATED-BUILD-PROFILES-REVIEW.md) ("runc fallback for disposable build
verification"). No run happens before that review passes.
