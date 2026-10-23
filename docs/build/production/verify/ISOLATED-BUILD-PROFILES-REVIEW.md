# Isolated-build security profiles: owner review

**APPROVED by the owner on 2026-10-21. Linux-runner validation and wiring are tracked separately.** Nothing here is installed, enabled or wired. `ZENITH_ISOLATED_BUILD_PROFILES` is not set anywhere, and no product code or workflow changed.

Untrusted-source builds run in a rootless BuildKit pod. The pod needs three node-side things before it will start: a seccomp profile (which system calls are allowed), an AppArmor profile (which files, networks and capabilities are allowed) and a RuntimeClass (which sandbox runs the pod). The drafts are in `deploy/zenith-managed/build/profiles/`.

| File | SHA-256 |
| --- | --- |
| `zenith-build-seccomp.json` (install as `/var/lib/kubelet/seccomp/zenith-build.json`) | `15391af9e1f9b9a6dcdc6b3c3abdd26128b5ca327d2d7e6afeb4487b1069dd3b` |
| `zenith-build.apparmor` (install as `/etc/apparmor.d/zenith-build`) | `802290e2d2b6b172fb5f5a404862ea1b70e784b0c6ff2137f77845b95ca42878` |
| `zenith-build-gvisor.runtimeclass.json` | `104ba2f070d622912f5899c44d5562776e62fa4d91708782ff8cba069eda8359` |

## What each profile does

**Seccomp (default deny).** Everything not listed fails with EPERM. The allow list starts from Docker's default profile (moby/profiles `seccomp/default.json`, main branch fetched 2026-10-21, latest tag `seccomp/v0.2.4`, file SHA-256 `6416b477...053f6`) and removes what a 64-bit builder never needs: 32-bit and x32 variants, clock adjustment, fanotify, `memfd_secret`. Allowed groups: files, memory, processes and signals, time and polling, sockets and IPC. Each group carries a comment in the file. Three groups need a reason:
- `socket()` only for unix, IPv4/IPv6 TCP and UDP, and route-netlink. Raw, packet, vsock, key and crypto sockets are refused.
- Group A (`unshare`, `clone`, `setns`, `pivot_root`, `chroot`, `sethostname`) and group B (`mount`, `umount2`, the new mount API) are allowed because rootless BuildKit builds a nested user and mount namespace for every `RUN` step. Docker's default profile only allows these with CAP_SYS_ADMIN, which this pod deliberately lacks, so I made them unconditional.
- `clone3` and the keyring calls return ENOSYS so libc and runc fall back cleanly.
Explicitly denied (and listed so the intent is visible): kexec, module loading, reboot, `bpf`, `perf_event_open`, `userfaultfd`, `io_uring`, `ptrace` and cross-process memory access, `keyctl`/`add_key`/`request_key`, `open_by_handle_at`, clock setting, swap, quota, NUMA policy, raw I/O ports.

**AppArmor `zenith-build`.** Allows TCP/UDP and unix sockets; denies raw and packet sockets. Allows only the capabilities rootless BuildKit uses (setuid/setgid for the UID helpers, sys_admin for mounts inside the nested namespace) and denies net_raw, net_admin, sys_module, sys_rawio, sys_ptrace, sys_time and similar. Denies every write under `/proc/sys` and `/sys`, `/proc/sysrq-trigger`, kernel memory and block devices, and mounting of kernel-internal filesystems (debugfs, securityfs, bpf, tracefs). This matters because the Job sets `procMount: Unmasked`, which switches off the runtime's normal read-only masking of `/proc`.
**Deviation from your brief:** I did not add "deny writes outside the workspace and /tmp". The profile also confines every build step, and a step writes into its own root filesystem, which AppArmor sees as `/`. Such a rule would break every `RUN`. Write confinement for the outer container already comes from the Job spec: read-only root filesystem, and writable volumes only at `/work`, `/tmp`, `/run/user/1000`, `/home/user`.

**RuntimeClass `zenith-build-gvisor`.** Handler `runsc` (gVisor), the one J14 already installs; same overhead (50m CPU, 64Mi) and node selector (`zenith.dev/runtime=gvisor`) as J14's `zenith-gvisor`. I made a separate class instead of reusing the J14 object so changing one lane's class cannot change the other's recorded baseline. Why gVisor: it puts a user-space kernel between untrusted build code and the host kernel, which matters most here because the seccomp and AppArmor profiles must allow user namespaces and mounts. Caveat: J14 only tested ordinary tenant pods under gVisor. Nobody has shown that rootless BuildKit, `hostUsers: false` and the builder's own user-namespace probe work under `runsc`. If that fails, the fallback is a runc/crun class with the same two profiles.

## Residual risks (not protected against)
- Mount and user-namespace syscalls are open to tenant code. Seccomp cannot limit them by target; the kernel (or gVisor) is the real gate, so a kernel or gVisor escape bug is not covered.
- Anything the build can reach through the allowed proxy (the allowlist proxy cannot inspect TLS contents).
- `ptrace` denial breaks `strace`, `gdb` and `proot` inside builds. 32-bit binaries are killed.
- CPU, memory and disk exhaustion is limited by the Job's limits, not by these profiles.
- Whether runsc applies AppArmor to guest processes, and honors the userns mapping, is unconfirmed (see open questions).

## How it will be wired (after approval)
`review-profile.ts` hashes the three files and fills in the digest. Sample run (invented tenant `ws-sample/env-sample`, example images; output not committed):

    npx tsx deploy/zenith-managed/build/review-profile.ts profile.input.json \
      deploy/zenith-managed/build/profiles/zenith-build-seccomp.json \
      deploy/zenith-managed/build/profiles/zenith-build.apparmor \
      deploy/zenith-managed/build/profiles/zenith-build-gvisor.runtimeclass.json profile.json
    {"tenant":"cea14098...","runtimeProfileDigest":"897374eb4b9c19774a93cd50f56b07603968e066051bc3c8dc1b8097fe88db6e","reviewedBuildProfileDigest":"e1f83ea0...00c4"}

- `config.nodeIsolation.profileDigest` = `897374eb...db6e` (tenant-independent). The node label `zenith.node-restriction.kubernetes.io/build-profile` takes its first 63 characters.
- `reviewedBuildProfileDigest` covers the whole tenant profile (cluster, credentials, images, proxy), so it differs per tenant and is computed at provisioning.
- Fixed config values: `runtimeClass: "zenith-build-gvisor"`, `seccompProfile: "zenith-build.json"`, `appArmorProfile: "zenith-build"`.
- `ZENITH_ISOLATED_BUILD_PROFILES` = a JSON array, one object per workspace, environment and provider: `workspaceId`, `environmentId`, `provider`, `server`, `credentialRef`, `verifierCredentialRef`, optional `caData`/`registryRepositoryRoot`, and `config` (the output of `review-profile.ts`). Namespaces must be `zb-<key>` and `zp-<key>`.
- The hashes above are the final approved hashes, of the files as committed with the banners removed.

## How to approve
Reply "approve", or name changes (for example a syscall to add or remove, the gVisor-versus-runc choice, or a split AppArmor profile).

## Tested after approval
1. `review-profile.ts` on the final bytes; existing profile tests and the J6 build contract tests.
2. On a Linux node with AppArmor (not this Mac): `apparmor_parser -Q` on the profile, load the seccomp file through kubelet, apply the RuntimeClass.
3. J6 steps in PROD-LIFE-09: the 14-check isolation probe, then a real source build, plus negative probes that a build step cannot call `ptrace`/`bpf`/`keyctl`, open raw sockets or write `/proc/sys`.
4. Revoke one precondition at a time and confirm the refusal.

## Open questions
- Does the verifier's node (Docker Desktop kind) have AppArmor enabled? Docker Desktop's VM may not (not checked), in which case kubelet refuses the pod and the AppArmor lane is blocked.
- Which BuildKit rootless version? The repo only uses the mutable tag `moby/buildkit:rootless`, resolved at verification. I did not check the profiles against a specific version.
- gVisor or runc, per the caveat above.
- Not checked in this environment: AppArmor syntax, seccomp loading, and every runtime behaviour above (no Linux node, no `apparmor_parser`).

## Findings from the hosted DRV-1 run (2026-10-23)
Hosted `drv1-private-source` on ubuntu-24.04-arm (kind, containerd, gVisor `release-20260928.0`, Calico v3.33.0).
- AppArmor: kind nodes do not mount securityfs, so kubelet refused the Localhost profile as unsupported. The DRV-1 fixture now mounts it and requires `zenith-build (enforce)` to be visible. After that, kubelet admitted the pod (run `39880088648`).
- gVisor with `hostUsers: false` fails. Every probe sandbox failed with
  `cannot create gofer process: gofer: error setting namespace of type user and path ".../pinned-namespaces/user": invalid argument`
  (run `39885437619`, source `27fbb5a2`). runsc cannot join the user namespace that containerd pins for the pod, so no build or probe container ever started under gVisor. This answers the "gVisor or runc" question for this release: gVisor and the mandatory outer pod user namespace cannot be combined.
- Not changed: the RuntimeClass, the profile digest, and the approved declaration. Changing the runtime changes the reviewed profile digest, so the owner must approve it again.
