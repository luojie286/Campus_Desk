package probe

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/key"
	"testing"
	"time"
)

func TestPeerResolutionStaysInsideTailnet(t *testing.T) {
	status := &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
		{}: {DNSName: "desk.example.ts.net.", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.2")}},
	}}
	ip, err := peerAddress(status, "DESK.example.ts.net")
	if err != nil || ip.String() != "100.64.0.2" {
		t.Fatal("peer lookup failed")
	}
	if _, err = peerAddress(status, "public.ts.net"); err == nil {
		t.Fatal("unknown name escaped peer map")
	}
	status.Peer[key.NewNode().Public()] = &ipnstate.PeerStatus{DNSName: "desk.example.ts.net.", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.3")}}
	if _, err = peerAddress(status, "desk.example.ts.net"); err == nil {
		t.Fatal("ambiguous peer accepted")
	}
}

func TestProxyTarget(t *testing.T) {
	for _, address := range []string{"desk.example.ts.net:443", "DESK.example.ts.net:443"} {
		if !allowedTarget(address) {
			t.Fatal(address)
		}
	}
	for _, address := range []string{"127.0.0.1:443", "desk.ts.net:80", "evil.ts.net.attacker.com:443", "-bad.ts.net:443", "a..ts.net:443", "evil\nfoo.ts.net:443", "[::1]:443", "name@desk.ts.net:443"} {
		if allowedTarget(address) {
			t.Fatal(address)
		}
	}
}
func TestProxyRejectsWithoutDial(t *testing.T) {
	called := false
	proxy, err := newTunnelProxy(func(context.Context, string, string) (net.Conn, error) { called = true; return nil, io.EOF }, "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	for _, item := range []struct {
		method, target, password string
		status                   int
	}{{"CONNECT", "desk.ts.net:443", "wrong", 407}, {"CONNECT", "127.0.0.1:443", "secret", 403}, {"GET", "desk.ts.net:443", "secret", 403}} {
		conn, err := net.Dial("tcp", proxy.listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		req := &http.Request{Method: item.method, Host: item.target, Header: make(http.Header)}
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("campusdesk:"+item.password)))
		// WriteProxy needs a URL for GET; the explicit wire format also tests CONNECT.
		_, err = io.WriteString(conn, item.method+" "+item.target+" HTTP/1.1\r\nHost: "+item.target+"\r\nProxy-Authorization: "+req.Header.Get("Proxy-Authorization")+"\r\n\r\n")
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(bufio.NewReader(conn), req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		conn.Close()
		if response.StatusCode != item.status {
			t.Fatalf("got %d", response.StatusCode)
		}
	}
	if called {
		t.Fatal("unauthorized target reached dial")
	}
}
func TestProxyTunnelAndShutdown(t *testing.T) {
	attempts := 0
	proxy, err := newTunnelProxy(func(ctx context.Context, network, address string) (net.Conn, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("tunnel_not_ready")
		}
		if address != "desk.ts.net:443" {
			t.Error("wrong target")
		}
		a, b := net.Pipe()
		go func() { defer b.Close(); _, _ = io.Copy(b, b) }()
		return a, nil
	}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	conn, err := net.Dial("tcp", proxy.listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	header := "Basic " + base64.StdEncoding.EncodeToString([]byte("campusdesk:secret"))
	io.WriteString(conn, "CONNECT desk.ts.net:443 HTTP/1.1\r\nHost: desk.ts.net:443\r\nProxy-Authorization: "+header+"\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("connect failed %v", err)
	}
	io.WriteString(conn, "encrypted-payload")
	value := make([]byte, len("encrypted-payload"))
	if _, err = io.ReadFull(reader, value); err != nil || string(value) != "encrypted-payload" {
		t.Fatal("tunnel corrupted payload")
	}
	proxy.close()
	if attempts != 2 {
		t.Fatalf("unexpected tunnel attempts: %d", attempts)
	}
	if _, err = reader.ReadByte(); err == nil {
		t.Fatal("shutdown left connection alive")
	}
}
