package domain

import (
	"encoding/binary"
	"path"
	"strings"
	"time"
)

// CustomFontMaxBytes caps the single uploaded TrueType font payload at 32 MiB.
const CustomFontMaxBytes = 32 * 1024 * 1024

// CustomFontMeta holds metadata for the single persisted cloud custom font
// without carrying its binary BLOB.
type CustomFontMeta struct {
	Name      string    `json:"name"`
	Enabled   bool      `json:"enabled"`
	SHA256    string    `json:"sha256"`
	SizeBytes int64     `json:"sizeBytes"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// CustomFontRecord pairs metadata with the raw font bytes read atomically from
// the same database row.
type CustomFontRecord struct {
	CustomFontMeta
	Data []byte
}

// HasTrueTypeSignature reports whether data starts with a TrueType sfnt header
// (0x00010000 or "true"). OpenType CFF ("OTTO") and collections ("ttcf") are rejected.
func HasTrueTypeSignature(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	sig := binary.BigEndian.Uint32(data[:4])
	return sig == 0x00010000 || sig == 0x74727565
}

// ValidateCustomFontName normalizes and validates a .ttf font display name.
func ValidateCustomFontName(raw string) (string, error) {
	cleaned := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	cleaned = path.Base(cleaned)
	if cleaned == "." || cleaned == "/" || cleaned == "" {
		return "", NewError(ErrCodeInvalidArgument, "字体文件名不能为空", nil)
	}
	for _, r := range cleaned {
		if r < 0x20 || r == 0x7f {
			return "", NewError(ErrCodeInvalidArgument, "字体文件名包含非法字符", nil)
		}
	}
	if len(cleaned) > 255 {
		return "", NewError(ErrCodeInvalidArgument, "字体文件名过长", nil)
	}
	if !strings.HasSuffix(strings.ToLower(cleaned), ".ttf") {
		return "", NewError(ErrCodeInvalidArgument, "仅支持 .ttf 字体文件", nil)
	}
	return cleaned, nil
}

// ValidateCustomFont validates name, size bounds, and TrueType signature.
func ValidateCustomFont(name string, data []byte) (string, error) {
	cleanName, err := ValidateCustomFontName(name)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", NewError(ErrCodeInvalidArgument, "字体文件为空", nil)
	}
	if len(data) > CustomFontMaxBytes {
		return "", NewError(ErrCodePayloadTooLarge, "字体文件不能超过 32 MiB", nil)
	}
	if !HasTrueTypeSignature(data) {
		return "", NewError(ErrCodeInvalidArgument, "文件不是有效的 TrueType 字体", nil)
	}
	return cleanName, nil
}
