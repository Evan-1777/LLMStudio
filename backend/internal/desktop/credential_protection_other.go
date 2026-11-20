//go:build !windows

package desktop

// PlatformCredentialProtector is unavailable outside Windows.
func PlatformCredentialProtector() CredentialProtector { return nil }
