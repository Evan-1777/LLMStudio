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

// Chat width modes and bounds for user preferences.
const (
	ChatWidthDefault       = "default"
	ChatWidthManual        = "manual"
	MinChatManualWidth     = 560
	MaxChatManualWidth     = 3840
	DefaultChatManualWidth = 780
)

// Typography presets and bounds for user preferences.
const (
	FontFamilySystem = "system"
	FontFamilySans   = "sans"
	FontFamilySerif  = "serif"
	FontFamilyKai    = "kai"
	FontFamilyMono   = "mono"
	MinFontSize      = 12
	MaxFontSize      = 22
	DefaultFontSize  = 14
)

// DefaultAppleBlue is the default accent color (#007AFF).
const DefaultAppleBlue = 0x007aff

// Tuning bounds shared by preference validation and the web client.
const (
	MinCollapseLineThreshold = 4
	MaxCollapseLineThreshold = 200
	MinCollapseCharThreshold = 120
	MaxCollapseCharThreshold = 20000
	MinMCPMaxToolRounds      = 1
	MaxMCPMaxToolRounds      = 100
	DefaultMCPMaxToolRounds  = 20
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
	ComposerReasoningEffort      string `json:"composerReasoningEffort"`
	MCPMaxToolRounds             int    `json:"mcpMaxToolRounds"`
	ChatWidthMode                string `json:"chatWidthMode"`
	ChatManualWidth              int    `json:"chatManualWidth"`
	FontFamily                   string `json:"fontFamily"`
	FontSize                     int    `json:"fontSize"`
	BuiltinTimeToolEnabled       bool   `json:"builtinTimeToolEnabled"`
	MathRenderEnabled            bool   `json:"mathRenderEnabled"`
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
		MCPMaxToolRounds:             DefaultMCPMaxToolRounds,
		ChatWidthMode:                ChatWidthDefault,
		ChatManualWidth:              DefaultChatManualWidth,
		FontFamily:                   FontFamilySystem,
		FontSize:                     DefaultFontSize,
		MathRenderEnabled:            true,
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
	ComposerReasoningEffort      *string `json:"composerReasoningEffort"`
	MCPMaxToolRounds             *int    `json:"mcpMaxToolRounds"`
	ChatWidthMode                *string `json:"chatWidthMode"`
	ChatManualWidth              *int    `json:"chatManualWidth"`
	FontFamily                   *string `json:"fontFamily"`
	FontSize                     *int    `json:"fontSize"`
	BuiltinTimeToolEnabled       *bool   `json:"builtinTimeToolEnabled"`
	MathRenderEnabled            *bool   `json:"mathRenderEnabled"`
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
	if p.ComposerReasoningEffort != nil {
		out.ComposerReasoningEffort = *p.ComposerReasoningEffort
	}
	if p.MCPMaxToolRounds != nil {
		out.MCPMaxToolRounds = *p.MCPMaxToolRounds
	}
	if p.ChatWidthMode != nil {
		out.ChatWidthMode = *p.ChatWidthMode
	}
	if p.ChatManualWidth != nil {
		out.ChatManualWidth = *p.ChatManualWidth
	}
	if p.FontFamily != nil {
		out.FontFamily = *p.FontFamily
	}
	if p.FontSize != nil {
		out.FontSize = *p.FontSize
	}
	if p.BuiltinTimeToolEnabled != nil {
		out.BuiltinTimeToolEnabled = *p.BuiltinTimeToolEnabled
	}
	if p.MathRenderEnabled != nil {
		out.MathRenderEnabled = *p.MathRenderEnabled
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
	p.ComposerReasoningEffort = strings.ToLower(strings.TrimSpace(p.ComposerReasoningEffort))
	p.ChatWidthMode = strings.ToLower(strings.TrimSpace(p.ChatWidthMode))
	if p.ChatWidthMode == "" {
		p.ChatWidthMode = defaults.ChatWidthMode
	}
	p.FontFamily = strings.ToLower(strings.TrimSpace(p.FontFamily))
	if p.FontFamily == "" {
		p.FontFamily = defaults.FontFamily
	}
	if p.FontSize == 0 {
		p.FontSize = defaults.FontSize
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
	switch p.ComposerReasoningEffort {
	case "", EffortNone, EffortLow, EffortMedium, EffortHigh, EffortXHigh, EffortMax:
	default:
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("unsupported composerReasoningEffort %q", p.ComposerReasoningEffort), nil)
	}
	if p.MCPMaxToolRounds < MinMCPMaxToolRounds || p.MCPMaxToolRounds > MaxMCPMaxToolRounds {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("mcpMaxToolRounds must be between %d and %d", MinMCPMaxToolRounds, MaxMCPMaxToolRounds), nil)
	}
	switch p.ChatWidthMode {
	case ChatWidthDefault, ChatWidthManual:
	default:
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("unsupported chatWidthMode %q", p.ChatWidthMode), nil)
	}
	if p.ChatManualWidth < MinChatManualWidth || p.ChatManualWidth > MaxChatManualWidth {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("chatManualWidth must be between %d and %d", MinChatManualWidth, MaxChatManualWidth), nil)
	}
	switch p.FontFamily {
	case FontFamilySystem, FontFamilySans, FontFamilySerif, FontFamilyKai, FontFamilyMono:
	default:
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("unsupported fontFamily %q", p.FontFamily), nil)
	}
	if p.FontSize < MinFontSize || p.FontSize > MaxFontSize {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("fontSize must be between %d and %d", MinFontSize, MaxFontSize), nil)
	}
	return ValidateAvatarDataURL(p.UserAvatarDataURL)
}
