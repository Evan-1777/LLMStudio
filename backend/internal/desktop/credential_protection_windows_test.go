package desktop

import (
	"bytes"
	"testing"
)

func TestDPAPIRoundTrip(t *testing.T) {
	p := PlatformCredentialProtector()
	plain := []byte("dpapi-test-key")
	encrypted, err := p.Protect(plain)
	if err != nil || len(encrypted) == 0 || bytes.Contains(encrypted, plain) {
		t.Fatalf("DPAPI protect: %v", err)
	}
	decrypted, err := p.Unprotect(encrypted)
	if err != nil || !bytes.Equal(decrypted, plain) {
		t.Fatalf("DPAPI unprotect: %v", err)
	}
	if _, err := p.Unprotect(plain); err == nil {
		t.Fatal("DPAPI accepted plaintext")
	}
}
