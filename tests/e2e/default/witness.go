// This disposable witness has no shell, provider SDK or external endpoint.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
)

type result struct {
	Kind  string `json:"kind"`
	Nonce string `json:"nonce"`
}

// die prints a fixed step code only, never a value or path.
func die(code ...string) {
	if len(code) == 1 {
		fmt.Fprintln(os.Stderr, "witness:failed:"+code[0])
	} else {
		fmt.Fprintln(os.Stderr, "witness:failed")
	}
	os.Exit(1)
}

const uncertaintyMarker = "uncertainty-ready.json"

var witnessNonce = regexp.MustCompile(`^[0-9a-f]{24}$`)

func requirePrivateWitnessIdentity() {
	if os.Geteuid() != 65532 || os.Getegid() != 65532 {
		die()
	}
}

func openPrivateWitnessDir() *os.File {
	fd, err := syscall.Open("/witness", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		die()
	}
	dir := os.NewFile(uintptr(fd), "/witness")
	info, err := dir.Stat()
	if err != nil {
		_ = dir.Close()
		die()
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || stat.Uid != 65532 || stat.Gid != 65532 || info.Mode() != os.ModeDir|0700 {
		_ = dir.Close()
		die()
	}
	return dir
}

func hold(nonce string) {
	if !witnessNonce.MatchString(nonce) {
		die()
	}
	requirePrivateWitnessIdentity()
	dir := openPrivateWitnessDir()
	defer dir.Close()
	fd, err := syscall.Openat(int(dir.Fd()), uncertaintyMarker,
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		die()
	}
	marker := os.NewFile(uintptr(fd), uncertaintyMarker)
	if err := marker.Chmod(0600); err != nil {
		_ = marker.Close()
		die()
	}
	value, err := json.Marshal(result{"zenith-default-journey", nonce})
	if err != nil {
		_ = marker.Close()
		die()
	}
	info, err := marker.Stat()
	if err != nil {
		_ = marker.Close()
		die()
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Uid != 65532 || stat.Gid != 65532 || info.Mode() != 0600 || info.Size() != 0 {
		_ = marker.Close()
		die()
	}
	if n, err := marker.Write(value); err != nil || n != len(value) {
		_ = marker.Close()
		die()
	}
	if err := marker.Close(); err != nil {
		die()
	}
	time.Sleep(90 * time.Second)
}

func holdRead(nonce string) {
	if !witnessNonce.MatchString(nonce) {
		die()
	}
	requirePrivateWitnessIdentity()
	dir := openPrivateWitnessDir()
	defer dir.Close()
	fd, err := syscall.Openat(int(dir.Fd()), uncertaintyMarker, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		die()
	}
	marker := os.NewFile(uintptr(fd), uncertaintyMarker)
	defer marker.Close()
	info, err := marker.Stat()
	if err != nil {
		die()
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Uid != 65532 || stat.Gid != 65532 || info.Mode() != 0600 || info.Size() < 1 || info.Size() > 512 {
		die()
	}
	value, err := io.ReadAll(io.LimitReader(marker, 513))
	var observed result
	if err != nil || len(value) != int(info.Size()) || len(value) > 512 || json.Unmarshal(value, &observed) != nil ||
		observed.Kind != "zenith-default-journey" || observed.Nonce != nonce {
		die()
	}
	canonical, err := json.Marshal(observed)
	if err != nil || string(value) != string(canonical) {
		die()
	}
	fmt.Println(string(value))
}

func write(name string, value []byte) {
	if err := os.WriteFile(name, value, 0600); err != nil {
		die("write-file")
	}
	if err := os.Chown(name, 65532, 65532); err != nil {
		die("write-chown")
	}
}
func main() {
	if len(os.Args) < 2 {
		die()
	}
	switch os.Args[1] {
	case "hold":
		if len(os.Args) != 3 {
			die()
		}
		hold(os.Args[2])
	case "hold-read":
		if len(os.Args) != 3 {
			die()
		}
		holdRead(os.Args[2])
	case "serve":
		value := result{"zenith-default-journey", os.Getenv("WITNESS_NONCE")}
		if value.Nonce == "" {
			die()
		}
		http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(value); err != nil {
				die()
			}
		})
		server := &http.Server{Addr: ":8080", ReadHeaderTimeout: 5 * time.Second}
		if err := server.ListenAndServe(); err != nil {
			die()
		}
	case "probe":
		client := &http.Client{Timeout: 5 * time.Second}
		response, err := client.Get("http://127.0.0.1:8080/")
		if err != nil || response.StatusCode != 200 {
			die()
		}
		defer response.Body.Close()
		if _, err := io.Copy(os.Stdout, io.LimitReader(response.Body, 4096)); err != nil {
			die()
		}
	case "seed-update":
		if os.Geteuid() != 65532 {
			die()
		}
		var input struct {
			Config json.RawMessage `json:"config"`
			Token  string          `json:"token"`
		}
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 65536)).Decode(&input); err != nil || len(input.Config) == 0 {
			die()
		}
		checkOwnedPrivate := func(name string, directory bool) {
			info, err := os.Lstat(name)
			if err != nil || info.Mode()&os.ModeSymlink != 0 || directory != info.IsDir() || !directory && !info.Mode().IsRegular() {
				die()
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			wantMode := os.FileMode(0600)
			if directory {
				wantMode = 0700
			}
			if !ok || stat.Uid != 65532 || stat.Gid != 65532 || info.Mode().Perm() != wantMode {
				die()
			}
		}
		checkOwnedPrivate("/witness", true)
		checkOwnedPrivate("/witness/config.json", false)
		checkOwnedPrivate("/witness/registration-token", false)
		checkOwnedPrivate("/witness/local-credential", false)
		if err := os.WriteFile("/witness/config.json", input.Config, 0600); err != nil {
			die()
		}
		if err := os.WriteFile("/witness/registration-token", []byte(input.Token), 0600); err != nil {
			die()
		}
	case "seed":
		// Called once as root with only CHOWN, inside the owned volume.
		var input struct {
			Config     json.RawMessage `json:"config"`
			Token      string          `json:"token"`
			Credential string          `json:"credential"`
		}
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 65536)).Decode(&input); err != nil {
			die("seed-input")
		}
		info, err := os.Lstat("/witness")
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			die("seed-lstat")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 65532 || stat.Gid != 65532 || info.Mode().Perm() != 0700 {
			die("seed-owner")
		}
		// The fresh volume inherits the image's 65532-owned private directory.
		// CHOWN is the sole added capability; take ownership before changing it.
		if err := os.Chown("/witness", 0, 0); err != nil {
			die("seed-chown-root")
		}
		if err := os.Chmod("/witness", 0700); err != nil {
			die("seed-chmod")
		}
		entries, err := os.ReadDir("/witness")
		if err != nil || len(entries) != 0 {
			die("seed-nonempty")
		}
		write("/witness/config.json", input.Config)
		write("/witness/registration-token", []byte(input.Token))
		write("/witness/local-credential", []byte(input.Credential))
		if err := os.Chown("/witness", 65532, 65532); err != nil {
			die("seed-chown")
		}
	case "write":
		if len(os.Args) != 3 || len(os.Args[2]) != 24 {
			die()
		}
		value, err := json.Marshal(result{"zenith-default-journey", os.Args[2]})
		if err != nil {
			die()
		}
		if err := os.WriteFile("/witness/result.json", value, 0600); err != nil {
			die()
		}
		credential, err := os.ReadFile("/witness/local-credential")
		if err != nil {
			die()
		}
		// A runtime-generated fake credential tests model-visible redaction.
		fmt.Println("Authorization: Bearer " + string(credential))
	case "read":
		value, err := os.ReadFile(filepath.Clean("/witness/result.json"))
		if err != nil {
			die()
		}
		fmt.Println(string(value))
	default:
		die()
	}
}
