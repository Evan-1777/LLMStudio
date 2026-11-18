package domain

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func encodeAvatar(t *testing.T, width, height int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 20, G: 120, B: 220, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestValidateAvatarDataURL(t *testing.T) {
	valid := encodeAvatar(t, 64, 64)
	oversized := encodeAvatar(t, MaxAvatarDimension+1, 16)
	truncated := valid[:len(valid)-8]
	jpeg := "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
	remote := "https://example.com/avatar.png"

	for _, tc := range []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "empty uses the default avatar", raw: ""},
		{name: "valid png", raw: valid},
		{name: "remote url rejected", raw: remote, wantErr: true},
		{name: "jpeg rejected", raw: jpeg, wantErr: true},
		{name: "not base64", raw: "data:image/png;base64,!!!!", wantErr: true},
		{name: "truncated png rejected", raw: truncated, wantErr: true},
		{name: "oversized dimensions rejected", raw: oversized, wantErr: true},
		{name: "oversized payload rejected", raw: "data:image/png;base64," + strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxAvatarBytes)+4), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateAvatarDataURL(tc.raw)
			if tc.wantErr && err == nil {
				t.Fatal("expected an error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if appErr, ok := AsAppError(err); err != nil && (!ok || appErr.Code != ErrCodeInvalidArgument) {
				t.Fatalf("unexpected error code: %v", err)
			}
		})
	}
}

func TestPreferencesValidateRejectsInvalidAvatar(t *testing.T) {
	prefs := DefaultPreferences()
	prefs.UserAvatarDataURL = "data:image/png;base64,bm90LWEtcG5n"
	if err := prefs.Validate(); err == nil {
		t.Fatal("expected invalid avatar to be rejected")
	}
	prefs.UserAvatarDataURL = encodeAvatar(t, 32, 32)
	if err := prefs.Validate(); err != nil {
		t.Fatalf("valid avatar rejected: %v", err)
	}
}
