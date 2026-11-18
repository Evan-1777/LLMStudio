package domain

import (
	"fmt"
	"strings"
)

// Theme modes for user preferences.
const (
	ThemeModeSystem = "system"
	ThemeModeLight  = "light"
	ThemeModeDark   = "dark"
)

// Chat display modes for user preferences.
const (
	ChatDisplayBubble = "bubble"
	ChatDisplayFeed   = "feed"
)

// DefaultAppleBlue is the default accent color (#007AFF).
const DefaultAppleBlue = 0x007aff

// Tuning bounds shared by preference validation and the web client.
const (
	MinCollapseLineThreshold = 4
	MaxCollapseLineThreshold = 200
	MinCollapseCharThreshold = 120
	MaxCollapseCharThreshold = 20000
)

// Preferences holds the single-user application preferences managed by the gateway.
// Gateway address and access token stay in browser connection storage and are not preferences.
type Preferences struct {
	ThemeMode                    string `json:"themeMode"`
	SeedColorValue               uint32 `json:"seedColorValue"`
	EnterToSend                  bool   `json:"enterToSend"`
	VisualHTMLRender             bool   `json:"visualHtmlRender"`
	DefaultHTMLPreview           bool   `json:"defaultHtmlPreview"`
	ChatDisplayMode              string `json:"chatDisplayMode"`
	AutoCollapseEnabled          bool   `json:"autoCollapseEnabled"`
	AutoCollapseThinkingComplete bool   `json:"autoCollapseThinkingOnComplete"`
	AutoCollapseToolsComplete    bool   `json:"autoCollapseToolsOnComplete"`
	AutoCreateCache              bool   `json:"autoCreateCache"`
	CollapseLineThreshold        int    `json:"collapseLineThreshold"`
	CollapseCharThreshold        int    `json:"collapseCharThreshold"`
	UserAvatarDataURL            string `json:"userAvatarDataUrl"`
}

// DefaultPreferences returns the built-in preference values.
func DefaultPreferences() Preferences {
	return Preferences{
		ThemeMode:                    ThemeModeSystem,
		SeedColorValue:               DefaultAppleBlue,
		EnterToSend:                  true,
		VisualHTMLRender:             true,
		DefaultHTMLPreview:           false,
		ChatDisplayMode:              ChatDisplayBubble,
		AutoCollapseEnabled:          true,
		AutoCollapseThinkingComplete: true,
		AutoCollapseToolsComplete:    true,
		AutoCreateCache:              false,
		CollapseLineThreshold:        24,
		CollapseCharThreshold:        1200,
	}
}

// PreferencesPatch carries a partial preference update; nil fields remain unchanged.
// JSON tags must mirror Preferences: two field names carry an extra "On" that the
// client contract uses, so case-insensitive decoding alone would drop them.
type PreferencesPatch struct {
	ThemeMode                    *string `json:"themeMode"`
	SeedColorValue               *uint32 `json:"seedColorValue"`
	EnterToSend                  *bool   `json:"enterToSend"`
	VisualHTMLRender             *bool   `json:"visualHtmlRender"`
	DefaultHTMLPreview           *bool   `json:"defaultHtmlPreview"`
	ChatDisplayMode              *string `json:"chatDisplayMode"`
	AutoCollapseEnabled          *bool   `json:"autoCollapseEnabled"`
	AutoCollapseThinkingComplete *bool   `json:"autoCollapseThinkingOnComplete"`
	AutoCollapseToolsComplete    *bool   `json:"autoCollapseToolsOnComplete"`
	AutoCreateCache              *bool   `json:"autoCreateCache"`
	CollapseLineThreshold        *int    `json:"collapseLineThreshold"`
	CollapseCharThreshold        *int    `json:"collapseCharThreshold"`
	UserAvatarDataURL            *string `json:"userAvatarDataUrl"`
}

// Merge overlays the patch onto base and returns the resulting preferences.
func (p PreferencesPatch) Merge(base Preferences) Preferences {
	out := base
	if p.ThemeMode != nil {
		out.ThemeMode = *p.ThemeMode
	}
	if p.SeedColorValue != nil {
		out.SeedColorValue = *p.SeedColorValue
	}
	if p.EnterToSend != nil {
		out.EnterToSend = *p.EnterToSend
	}
	if p.VisualHTMLRender != nil {
		out.VisualHTMLRender = *p.VisualHTMLRender
	}
	if p.DefaultHTMLPreview != nil {
		out.DefaultHTMLPreview = *p.DefaultHTMLPreview
	}
	if p.ChatDisplayMode != nil {
		out.ChatDisplayMode = *p.ChatDisplayMode
	}
	if p.AutoCollapseEnabled != nil {
		out.AutoCollapseEnabled = *p.AutoCollapseEnabled
	}
	if p.AutoCollapseThinkingComplete != nil {
		out.AutoCollapseThinkingComplete = *p.AutoCollapseThinkingComplete
	}
	if p.AutoCollapseToolsComplete != nil {
		out.AutoCollapseToolsComplete = *p.AutoCollapseToolsComplete
	}
	if p.AutoCreateCache != nil {
		out.AutoCreateCache = *p.AutoCreateCache
	}
	if p.CollapseLineThreshold != nil {
		out.CollapseLineThreshold = *p.CollapseLineThreshold
	}
	if p.CollapseCharThreshold != nil {
		out.CollapseCharThreshold = *p.CollapseCharThreshold
	}
	if p.UserAvatarDataURL != nil {
		out.UserAvatarDataURL = *p.UserAvatarDataURL
	}
	return out
}

// Normalize trims text fields and applies defaults to unset enum values.
func (p Preferences) Normalize() Preferences {
	defaults := DefaultPreferences()
	p.ThemeMode = strings.ToLower(strings.TrimSpace(p.ThemeMode))
	if p.ThemeMode == "" {
		p.ThemeMode = defaults.ThemeMode
	}
	p.ChatDisplayMode = strings.ToLower(strings.TrimSpace(p.ChatDisplayMode))
	if p.ChatDisplayMode == "" {
		p.ChatDisplayMode = defaults.ChatDisplayMode
	}
	return p
}

// Validate reports whether every field is a supported value.
func (p Preferences) Validate() error {
	switch p.ThemeMode {
	case ThemeModeSystem, ThemeModeLight, ThemeModeDark:
	default:
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("unsupported themeMode %q", p.ThemeMode), nil)
	}
	switch p.ChatDisplayMode {
	case ChatDisplayBubble, ChatDisplayFeed:
	default:
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("unsupported chatDisplayMode %q", p.ChatDisplayMode), nil)
	}
	if p.SeedColorValue > 0xffffffff {
		return NewError(ErrCodeInvalidArgument, "seedColorValue must be a 32-bit unsigned integer", nil)
	}
	if p.CollapseLineThreshold < MinCollapseLineThreshold || p.CollapseLineThreshold > MaxCollapseLineThreshold {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("collapseLineThreshold must be between %d and %d", MinCollapseLineThreshold, MaxCollapseLineThreshold), nil)
	}
	if p.CollapseCharThreshold < MinCollapseCharThreshold || p.CollapseCharThreshold > MaxCollapseCharThreshold {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("collapseCharThreshold must be between %d and %d", MinCollapseCharThreshold, MaxCollapseCharThreshold), nil)
	}
	return ValidateAvatarDataURL(p.UserAvatarDataURL)
}
