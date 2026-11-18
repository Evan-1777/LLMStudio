package domain

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"strings"
)

// Bounds for stored avatar images. The browser crops to 128x128 and the gateway
// re-validates the decoded PNG before persisting it with the owning record.
const (
	MaxAvatarDimension = 128
	MaxAvatarBytes     = 96 * 1024
	avatarDataURLPref  = "data:image/png;base64,"
)

// ValidateAvatarDataURL accepts an empty value (default avatar) or a base64 PNG
// data URL that decodes to a complete PNG no larger than 128x128 / 96 KiB.
// Invalid content is reported as INVALID_ARGUMENT and never logged.
func ValidateAvatarDataURL(raw string) error {
	if raw == "" {
		return nil
	}
	if !strings.HasPrefix(raw, avatarDataURLPref) {
		return invalidAvatarError()
	}
	payload := raw[len(avatarDataURLPref):]
	if len(payload) > base64.StdEncoding.EncodedLen(MaxAvatarBytes) {
		return invalidAvatarError()
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || len(data) == 0 || len(data) > MaxAvatarBytes {
		return invalidAvatarError()
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width > MaxAvatarDimension || cfg.Height > MaxAvatarDimension {
		return invalidAvatarError()
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return invalidAvatarError()
	}
	return nil
}

func invalidAvatarError() error {
	return NewError(ErrCodeInvalidArgument, "avatarDataUrl must be an empty value or a PNG data URL within 128x128 and 96 KiB", nil)
}
