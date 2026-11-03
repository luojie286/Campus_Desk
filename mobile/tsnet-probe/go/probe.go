// Package probe is an experimental per-app Tailscale transport. It never creates
// Android VpnService or changes the phone's system routes.
package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
)

type InterfaceSource interface{ Snapshot() string }
type Observer interface{ Event(event string) }
type ifaceRow struct {
	Index, MTU, Flags int
	Name              string
	Addresses         []string
}

// Android disallows Go's netlink interface enumeration for normal applications.
// Use java.net.NetworkInterface through a narrow callback, with real addresses
// only in memory. Do not fabricate network interfaces or patch the Go runtime.
func registerInterfaces(source InterfaceSource) {
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		var rows []ifaceRow
		if err := json.Unmarshal([]byte(source.Snapshot()), &rows); err != nil {
			return nil, fmt.Errorf("interface_snapshot_invalid")
		}
		out := make([]netmon.Interface, 0, len(rows))
		for _, row := range rows {
			addrs := []net.Addr{}
			for _, address := range row.Addresses {
				ip, subnet, err := net.ParseCIDR(address)
				if err == nil {
					subnet.IP = ip
					addrs = append(addrs, subnet)
				}
			}
			out = append(out, netmon.Interface{Interface: &net.Interface{Index: row.Index, MTU: row.MTU, Name: row.Name, Flags: net.Flags(row.Flags)}, AltAddrs: addrs})
		}
		return out, nil
	})
}

type Client struct {
	server        *tsnet.Server
	observer      Observer
	mu            sync.Mutex
	cancel        context.CancelFunc
	dir           string
	proxy         *tunnelProxy
	proxyPassword string
}

func emit(observer Observer, values map[string]any) {
	data, _ := json.Marshal(values)
	observer.Event(string(data))
}
func NewClient(dir string, source InterfaceSource, observer Observer) *Client {
	return NewClientNamed(dir, "campusdesk-android-probe", source, observer)
}
func NewClientNamed(dir, hostname string, source InterfaceSource, observer Observer) *Client {
	envknob.SetNoLogsNoSupport()
	// Android apps have neither a shell HOME nor a writable working directory.
	// Even with uploads disabled, tsnet's backend needs an explicit state path.
	envknob.Setenv("TS_LOGS_DIR", dir)
	registerInterfaces(source)
	authPattern := regexp.MustCompile(`https://login\.tailscale\.com/[^\s]+`)
	server := &tsnet.Server{Dir: dir, Hostname: hostname, Logf: func(string, ...any) {}}
	// Only the login URL is shown to the owner, not general logs, account names,
	// peer addresses or authentication tokens. No auth key is embedded in APK.
	server.UserLogf = func(format string, args ...any) {
		if link := authPattern.FindString(fmt.Sprintf(format, args...)); link != "" {
			emit(observer, map[string]any{"stage": "login_required", "url": link})
		}
	}
	return &Client{server: server, observer: observer, dir: dir}
}
func (c *Client) Start() {
	c.mu.Lock()
	if c.cancel != nil {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	c.cancel = cancel
	c.mu.Unlock()
	go func() {
		defer func() {
			if value := recover(); value != nil {
				// Experimental crash diagnostic stays inside the app sandbox. Never
				// include the request token or HTTP body; this runs during node startup.
				emit(c.observer, map[string]any{"stage": "startup_panicked"})
			}
		}()
		emit(c.observer, map[string]any{"stage": "starting"})
		if _, err := c.server.Up(ctx); err != nil {
			// Error text can contain private network metadata; keep public status stable.
			emit(c.observer, map[string]any{"stage": "start_failed"})
			return
		}
		emit(c.observer, map[string]any{"stage": "online"})
	}()
}
func (c *Client) Read(base, token string) {
	go func() {
		u, err := url.Parse(base)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			emit(c.observer, map[string]any{"stage": "invalid_target"})
			return
		}
		client := c.server.HTTPClient()
		client.Timeout = 25 * time.Second
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		u.Path = "/v1/tasks"
		u.RawQuery = "limit=1"
		req, _ := http.NewRequest("GET", u.String(), nil)
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(req)
		if err != nil {
			// Local diagnostic only: strip endpoint and token before persistence.
			message := strings.ReplaceAll(err.Error(), token, "[redacted]")
			message = strings.ReplaceAll(message, u.Host, "[target]")
			_ = os.WriteFile(filepath.Join(c.dir, "read-error.txt"), []byte(message), 0600)
			emit(c.observer, map[string]any{"stage": "read_failed"})
			return
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
		valid := err == nil && len(data) <= 1024*1024 && json.Valid(data)
		emit(c.observer, map[string]any{"stage": "read_complete", "status": response.StatusCode, "validJson": valid})
	}()
}
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		c.cancel()
	}
	if c.proxy != nil {
		c.proxy.close()
	}
	_ = c.server.Close()
}
