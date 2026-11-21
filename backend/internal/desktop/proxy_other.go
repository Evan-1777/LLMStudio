//go:build !windows

package desktop

import (
	"net/http"
	"net/url"
)

func platformSystemProxy(_ *http.Request) (*url.URL, error) {
	return nil, nil
}
