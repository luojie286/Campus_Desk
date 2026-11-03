package probe

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"tailscale.com/ipn/ipnstate"
	"time"
)

// The local proxy is only a bridge for the app's existing TLS HTTP client.
// It never decrypts TLS, accepts plain HTTP requests or uses system-network dial.
type tunnelProxy struct {
	listener    net.Listener
	server      *http.Server
	connections sync.Map
}
type tunnelDial func(context.Context, string, string) (net.Conn, error)

// Resolve exclusively from the authenticated tailnet peer map. Never resolve
// a ts.net name with public DNS or allow UserDial to choose a system route.
func peerAddress(status *ipnstate.Status, hostname string) (netip.Addr, error) {
	if status == nil {
		return netip.Addr{}, errors.New("tailnet_status_unavailable")
	}
	var found netip.Addr
	for _, peer := range status.Peer {
		if strings.EqualFold(strings.TrimSuffix(peer.DNSName, "."), hostname) && len(peer.TailscaleIPs) > 0 {
			if found.IsValid() {
				return netip.Addr{}, errors.New("ambiguous_tailnet_peer")
			}
			found = peer.TailscaleIPs[0]
		}
	}
	if !found.IsValid() {
		return netip.Addr{}, errors.New("tailnet_peer_not_ready")
	}
	return found, nil
}

func allowedTarget(address string) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" || !strings.HasSuffix(strings.ToLower(host), ".ts.net") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	return true
}
func newTunnelProxy(dial tunnelDial, password string) (*tunnelProxy, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("private_proxy_listen_failed")
	}
	proxy := &tunnelProxy{listener: listener}
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("campusdesk:"+password))
	proxy.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(expected)) != 1 {
			w.Header().Set("Proxy-Authenticate", `Basic realm="CampusDesk"`)
			http.Error(w, "proxy_auth_required", 407)
			return
		}
		if r.Method != http.MethodConnect || !allowedTarget(r.Host) {
			http.Error(w, "target_denied", 403)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		remote, err := dial(ctx, "tcp", r.Host)
		// Running can precede the initial MagicDNS peer map. Wait briefly for
		// tunnel readiness before reporting failure. No TLS or application bytes
		// have been sent, so this also safely precedes a later POST exactly once.
		for attempt := 0; err != nil && ctx.Err() == nil && attempt < 8; attempt++ {
			delay := time.Duration(attempt+1) * 250 * time.Millisecond
			select {
			case <-time.After(delay):
				remote, err = dial(ctx, "tcp", r.Host)
			case <-ctx.Done():
			}
		}
		cancel()
		if err != nil {
			http.Error(w, "private_network_unavailable", 502)
			return
		}
		defer remote.Close()
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "proxy_unavailable", 500)
			return
		}
		local, buffer, err := hijacker.Hijack()
		if err != nil {
			return
		}
		proxy.connections.Store(local, remote)
		defer func() { proxy.connections.Delete(local); local.Close() }()
		if _, err = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err = buffer.Flush(); err != nil {
			return
		}
		// Closing either direction closes both sockets so shutdown never strands
		// a reader goroutine. Tokens and payload stay inside the TLS stream.
		go func() { _, _ = io.Copy(remote, buffer); remote.Close(); local.Close() }()
		_, _ = io.Copy(local, remote)
	})}
	go func() { _ = proxy.server.Serve(listener) }()
	return proxy, nil
}
func (p *tunnelProxy) close() {
	_ = p.server.Close()
	p.connections.Range(func(a, b any) bool { _ = a.(net.Conn).Close(); _ = b.(net.Conn).Close(); return true })
}
func (c *Client) ProxyAddress() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.proxy == nil {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return "", errors.New("proxy_random_failed")
		}
		c.proxyPassword = hex.EncodeToString(key)
		proxy, err := newTunnelProxy(func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, _ := net.SplitHostPort(address)
			local, err := c.server.LocalClient()
			if err != nil {
				return nil, errors.New("tailnet_not_started")
			}
			status, err := local.Status(ctx)
			if err != nil {
				return nil, errors.New("tailnet_status_unavailable")
			}
			ip, err := peerAddress(status, host)
			if err != nil {
				return nil, err
			}
			conn, err := c.server.Dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if err != nil {
				_ = os.WriteFile(filepath.Join(c.dir, "proxy-dial-error.txt"), []byte(strings.ReplaceAll(err.Error(), address, "[target]")), 0600)
			}
			return conn, err
		}, c.proxyPassword)
		if err != nil {
			return "", err
		}
		c.proxy = proxy
	}
	return c.proxy.listener.Addr().String(), nil
}
func (c *Client) ProxyPassword() string { c.mu.Lock(); defer c.mu.Unlock(); return c.proxyPassword }
