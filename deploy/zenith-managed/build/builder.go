// Trusted entrypoint: tenant code only enters BuildKit's full OCI process sandbox.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	archivepath "path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func extract(archive []byte, destination, expected string) error {
	sum := sha256.Sum256(archive)
	if hex.EncodeToString(sum[:]) != expected {
		return errors.New("source digest mismatch")
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(io.LimitReader(gz, 64*1024*1024+1))
	seen := map[string]bool{}
	total := int64(0)
	for count := 0; ; count++ {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(h.Name, "/")
		if count >= 10000 || name == "" || archivepath.IsAbs(name) || strings.Contains(name, "\\") || strings.Contains(name, ":") || archivepath.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") || seen[name] {
			return errors.New("unsafe archive path")
		}
		seen[name] = true
		path := filepath.Join(destination, name)
		if h.Typeflag == tar.TypeDir {
			if err = os.MkdirAll(path, 0700); err != nil {
				return err
			}
			continue
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return errors.New("links and special archive entries are refused")
		}
		total += h.Size
		if h.Size < 0 || h.Size > 16*1024*1024 || total > 64*1024*1024 {
			return errors.New("unpacked source limit")
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if h.Mode&0111 != 0 {
			mode = 0700
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return err
		}
		_, err = io.CopyN(f, tr, h.Size)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if len(seen) == 0 {
		return errors.New("empty archive")
	}
	return nil
}
func absent(path string) bool { _, e := os.Stat(path); return os.IsNotExist(e) }
func writeDenied(path string) bool {
	e := os.WriteFile(path, []byte("probe"), 0600)
	if e == nil {
		_ = os.Remove(path)
		return false
	}
	return true
}
func deniedAddress(address string) bool {
	c, e := net.DialTimeout("tcp", address, 2*time.Second)
	if e == nil {
		c.Close()
		return false
	}
	return true
}
// Negative probes: each attempts an operation that succeeds for an unconfined process and must be refused here (by the
// seccomp filter, AppArmor or missing capabilities). None is a malformed call that would fail for its own reasons.

// ptraceDenied: PTRACE_TRACEME succeeds for any unconfined process with a parent.
func ptraceDenied() bool {
	_, _, errno := syscall.Syscall(syscall.SYS_PTRACE, syscall.PTRACE_TRACEME, 0, 0)
	return errno != 0
}

// bpfDenied: creating a one-entry array map succeeds wherever bpf is permitted.
func bpfDenied() bool {
	attr := [4]uint32{2 /* BPF_MAP_TYPE_ARRAY */, 4, 4, 1}
	nr, ok := map[string]uintptr{"amd64": 321, "arm64": 280}[runtime.GOARCH] // __NR_bpf; the syscall package lacks it on arm64
	if !ok {
		return false
	}
	fd, _, errno := syscall.Syscall(nr, 0 /* BPF_MAP_CREATE */, uintptr(unsafe.Pointer(&attr[0])), unsafe.Sizeof(attr))
	if errno == 0 {
		syscall.Close(int(fd))
	}
	return errno != 0
}

// keyctlDenied: KEYCTL_GET_KEYRING_ID on the session keyring succeeds for any process allowed to use keyrings.
func keyctlDenied() bool {
	_, _, errno := syscall.Syscall(syscall.SYS_KEYCTL, 0 /* KEYCTL_GET_KEYRING_ID */, ^uintptr(2) /* KEY_SPEC_SESSION_KEYRING (-3) */, 0)
	return errno != 0
}

// rawSocketDenied: a raw ICMP socket.
func rawSocketDenied() bool {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, syscall.IPPROTO_ICMP)
	if err == nil {
		syscall.Close(fd)
	}
	return err != nil
}

// procSysWriteDenied: opening a kernel tunable for writing (nothing is written).
func procSysWriteDenied() bool {
	f, err := os.OpenFile("/proc/sys/kernel/hostname", os.O_WRONLY, 0)
	if err == nil {
		f.Close()
	}
	return err != nil
}

// seccompEnforced: the kernel reports filter mode (2) for this process, so the Localhost profile is applied, not just requested.
func seccompEnforced() bool {
	b, e := os.ReadFile("/proc/self/status")
	if e != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "Seccomp:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "Seccomp:")) == "2"
		}
	}
	return false
}

// appArmorEnforced: this process is confined by the zenith-build profile in enforce mode (newer kernels expose the
// AppArmor-specific attribute; older ones only the shared one).
func appArmorEnforced() bool {
	for _, file := range []string{"/proc/self/attr/apparmor/current", "/proc/self/attr/current"} {
		if b, e := os.ReadFile(file); e == nil {
			return strings.TrimRight(string(b), "\x00\n") == "zenith-build (enforce)"
		}
	}
	return false
}
func userNamespace() bool {
	data, e := os.ReadFile("/proc/self/uid_map")
	if e != nil {
		return false
	}
	fields := strings.Fields(string(data))
	if len(fields) != 3 {
		return false
	}
	start, e1 := strconv.ParseUint(fields[1], 10, 64)
	size, e2 := strconv.ParseUint(fields[2], 10, 64)
	return e1 == nil && e2 == nil && start > 0 && size > 0 && size <= 65536
}
func boundedResources() bool {
	memory, e := os.ReadFile("/sys/fs/cgroup/memory.max")
	if e != nil {
		return false
	}
	n, e := strconv.ParseInt(strings.TrimSpace(string(memory)), 10, 64)
	if e != nil || n <= 0 || n > 4*1024*1024*1024 {
		return false
	}
	cpu, e := os.ReadFile("/sys/fs/cgroup/cpu.max")
	if e != nil {
		return false
	}
	f := strings.Fields(string(cpu))
	if len(f) != 2 {
		return false
	}
	q, e1 := strconv.ParseInt(f[0], 10, 64)
	p, e2 := strconv.ParseInt(f[1], 10, 64)
	return e1 == nil && e2 == nil && q > 0 && p > 0 && q <= 2*p
}

// Kubernetes injects these discovery links even when enableServiceLinks is false.
// Remove them before the strict credential guard, so neither daemon nor executor inherits them.
func stripKubeDiscoveryEnv() error {
	for _, key := range []string{"KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "KUBERNETES_SERVICE_PORT_HTTPS", "KUBERNETES_PORT", "KUBERNETES_PORT_443_TCP", "KUBERNETES_PORT_443_TCP_PROTO", "KUBERNETES_PORT_443_TCP_PORT", "KUBERNETES_PORT_443_TCP_ADDR"} {
		if err := os.Unsetenv(key); err != nil {
			return err
		}
	}
	return nil
}
func noDeploymentEnv() bool {
	for _, v := range os.Environ() {
		k := strings.SplitN(v, "=", 2)[0]
		for _, prefix := range []string{"AWS_", "AZURE_", "GOOGLE_", "KUBERNETES_", "ZENITH_CONTROL_", "ZENITH_VAULT_"} {
			if strings.HasPrefix(k, prefix) {
				return false
			}
		}
	}
	return true
}
func proxyDenied() bool {
	u, e := url.Parse(os.Getenv("HTTP_PROXY"))
	if e != nil || u.Host == "" {
		return false
	}
	client := http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u)}}
	r, e := client.Get("http://169.254.169.254/latest/meta-data/")
	if e != nil {
		return false
	}
	defer r.Body.Close()
	return r.StatusCode == http.StatusForbidden
}
func proxyAllowed() bool {
	u, err := url.Parse(os.Getenv("HTTP_PROXY"))
	if err != nil || u.Host == "" {
		return false
	}
	client := http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u)}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(os.Getenv("ZENITH_REGISTRY_PROBE_URL"))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK || response.StatusCode == http.StatusUnauthorized
}
func outerChecks() map[string]bool {
	return map[string]bool{
		"nonRoot": os.Getuid() == 1000, "userNamespace": userNamespace(), "noToken": absent("/var/run/secrets/kubernetes.io/serviceaccount/token"),
		"noDeploymentEnv": noDeploymentEnv(), "rootReadOnly": writeDenied("/zenith-root-probe"),
		"sourceReadOnly": writeDenied("/source/zenith-source-probe"), "metadataDenied": deniedAddress("169.254.169.254:80") && deniedAddress("[fd00:ec2::254]:80"),
		"credentialsEndpointDenied": deniedAddress("169.254.170.2:80"), "directEgressDenied": deniedAddress("1.1.1.1:443"),
		"proxyDenied": proxyDenied(), "proxyAllowed": proxyAllowed(), "registryDirectDenied": os.Getenv("ZENITH_REGISTRY_PROBE_ENDPOINT") != "" && deniedAddress(os.Getenv("ZENITH_REGISTRY_PROBE_ENDPOINT")), "resourcesBounded": boundedResources(),
		"seccompEnforced": seccompEnforced(), "appArmorEnforced": appArmorEnforced(),
		"ptraceDenied": ptraceDenied(), "bpfDenied": bpfDenied(), "keyctlDenied": keyctlDenied(), "rawSocketDenied": rawSocketDenied(), "procSysWriteDenied": procSysWriteDenied(),
	}
}
func fullProcessSandbox() error {
	if !absent("/registry-auth/config.json") || !absent("/source/source.tar.gz") || !absent("/run/user/1000/buildkit/buildkitd.sock") {
		return errors.New("daemon credentials or mounts exposed")
	}
	entries, e := os.ReadDir("/proc")
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if _, e := strconv.Atoi(entry.Name()); e != nil {
			continue
		}
		b, e := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if e == nil && (bytes.Contains(b, []byte("buildkitd")) || bytes.Contains(b, []byte("rootlesskit"))) {
			return errors.New("daemon visible from build executor")
		}
	}
	return nil
}
func runBuild(ctx context.Context, contextDir, dockerfile, image string, httpRegistry bool) error {
	args := []string{"build", "--frontend", "dockerfile.v0", "--local", "context=" + contextDir, "--local", "dockerfile=" + filepath.Dir(dockerfile), "--opt", "filename=" + filepath.Base(dockerfile)}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"} {
		args = append(args, "--opt", "build-arg:"+key+"="+os.Getenv(key))
	}
	if image != "" {
		output := "type=image,name=" + image + ",push=true"
		if httpRegistry {
			output += ",registry.insecure=true"
		}
		args = append(args, "--output", output, "--opt", "attest:provenance=mode=min,version=v1,builder-id="+os.Getenv("ZENITH_BUILD_ID")+"", "--metadata-file", "/work/metadata.json")
	} else {
		args = append(args, "--output", "type=cacheonly")
	}
	command := exec.CommandContext(ctx, "buildctl-daemonless.sh", args...)
	// No insecure entitlements and never --oci-worker-no-process-sandbox.
	command.Env = append(os.Environ(), "BUILDKITD_FLAGS=--oci-worker-rootless --oci-worker-snapshotter=native --root /home/user/.local/share/buildkit")
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}
func receipt(value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	if len(b) > 4096 {
		return errors.New("receipt too large")
	}
	return os.WriteFile("/dev/termination-log", b, 0600)
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "exec-probe" {
		if e := fullProcessSandbox(); e != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 3 {
		os.Exit(1)
	}
	// Repeat preconditions immediately before source execution, even after controller preflight.
	if err := stripKubeDiscoveryEnv(); err != nil {
		os.Exit(1)
	}
	checks := outerChecks()
	for _, ok := range checks {
		if !ok {
			fmt.Fprintln(os.Stderr, "isolation precondition failed")
			os.Exit(1)
		}
	}
	archive, e := os.ReadFile("/source/source.tar.gz")
	if e != nil || len(archive) > 700*1024 {
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 29*time.Minute)
	defer cancel()
	switch os.Args[1] {
	case "probe":
		if e = os.MkdirAll("/work/probe", 0700); e != nil {
			os.Exit(1)
		}
		binary, e := os.ReadFile("/usr/local/bin/zenith-builder")
		if e != nil {
			os.Exit(1)
		}
		if e = os.WriteFile("/work/probe/probe", binary, 0700); e != nil {
			os.Exit(1)
		}
		if e = os.WriteFile("/work/probe/Dockerfile", []byte("FROM scratch\nCOPY probe /probe\nRUN [\"/probe\",\"exec-probe\"]\n"), 0600); e != nil {
			os.Exit(1)
		}
		if e = runBuild(ctx, "/work/probe", "/work/probe/Dockerfile", "", false); e != nil {
			os.Exit(1)
		}
		checks["processSandbox"] = true
		if e = receipt(map[string]any{"version": 1, "checks": checks}); e != nil {
			os.Exit(1)
		}
	case "build":
		if len(os.Args) != 7 {
			os.Exit(1)
		}
		if e = extract(archive, "/work/context", os.Args[2]); e != nil {
			fmt.Fprintln(os.Stderr, "source extraction refused")
			os.Exit(1)
		}
		contextPath := filepath.Join("/work/context", os.Args[3])
		dockerfile := filepath.Join("/work/context", os.Args[4])
		if e = runBuild(ctx, contextPath, dockerfile, os.Args[5], os.Args[6] == "http"); e != nil {
			os.Exit(1)
		}
		b, e := os.ReadFile("/work/metadata.json")
		if e != nil {
			os.Exit(1)
		}
		var metadata map[string]json.RawMessage
		if json.Unmarshal(b, &metadata) != nil {
			os.Exit(1)
		}
		var imageDigest string
		if json.Unmarshal(metadata["containerimage.digest"], &imageDigest) != nil || len(imageDigest) != 71 || !strings.HasPrefix(imageDigest, "sha256:") {
			os.Exit(1)
		}
		if e = receipt(map[string]any{"digest": imageDigest, "provenanceRequested": true}); e != nil {
			os.Exit(1)
		}
	default:
		os.Exit(1)
	}
}
