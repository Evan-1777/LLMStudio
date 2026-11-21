package service

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"llmstudio/backend/internal/plugin"
)

const (
	BuiltinServerID     = "builtin"
	BuiltinServerName   = "内置工具"
	BuiltinTimeToolName = "get_current_time"
)

var builtinTimeInputSchema = json.RawMessage(`{"type":"object","properties":{"timezone":{"type":"string","description":"Optional IANA timezone name (e.g. 'Asia/Shanghai', 'America/New_York', 'UTC') or fixed UTC offset (e.g. '+08:00', '-05:00'). Defaults to local timezone if omitted."}},"additionalProperties":false}`)

// BuiltinTimeToolDescriptor returns the MCP descriptor for the built-in timezone clock tool.
func BuiltinTimeToolDescriptor() plugin.MCPToolDescriptor {
	readOnly := true
	idempotent := true
	destructive := false
	openWorld := false
	return plugin.MCPToolDescriptor{
		Name:        BuiltinTimeToolName,
		Title:       "当前日期与时间",
		Description: "Get the current date and time for a specified IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York', 'UTC') or UTC offset (e.g. '+08:00'). Defaults to the local timezone if omitted.",
		InputSchema: builtinTimeInputSchema,
		Annotations: &plugin.MCPToolAnnotations{
			ReadOnlyHint:    &readOnly,
			IdempotentHint:  &idempotent,
			DestructiveHint: &destructive,
			OpenWorldHint:   &openWorld,
		},
	}
}

// BuiltinTimeChatTool returns the ChatTool entry exposed to LLM providers when enabled.
func BuiltinTimeChatTool() plugin.ChatTool {
	desc := BuiltinTimeToolDescriptor()
	return plugin.ChatTool{
		Alias:       BuiltinTimeToolName,
		ServerID:    BuiltinServerID,
		ServerName:  BuiltinServerName,
		ToolName:    BuiltinTimeToolName,
		Description: desc.Description,
		InputSchema: desc.InputSchema,
	}
}

// ExecuteBuiltinTimeToolForTest exposes executeBuiltinTimeTool for black-box service_test verification.
func ExecuteBuiltinTimeToolForTest(now time.Time, rawArgs json.RawMessage) plugin.MCPCallToolResult {
	return executeBuiltinTimeTool(now, rawArgs)
}

func executeBuiltinTimeTool(now time.Time, rawArgs json.RawMessage) plugin.MCPCallToolResult {
	var args struct {
		Timezone string `json:"timezone"`
	}
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return plugin.MCPCallToolResult{
				IsError: true,
				Content: []plugin.MCPToolContent{{Type: "text", Text: fmt.Sprintf("invalid arguments: %v", err)}},
			}
		}
	}

	loc, err := resolveBuiltinTimezone(args.Timezone)
	if err != nil {
		return plugin.MCPCallToolResult{
			IsError: true,
			Content: []plugin.MCPToolContent{{Type: "text", Text: err.Error()}},
		}
	}

	target := now.In(loc)
	_, offsetSec := target.Zone()
	payload := struct {
		Timezone string `json:"timezone"`
		Offset   string `json:"offset"`
		DateTime string `json:"datetime"`
		Date     string `json:"date"`
		Time     string `json:"time"`
		Weekday  string `json:"weekday"`
		Unix     int64  `json:"unix"`
	}{
		Timezone: loc.String(),
		Offset:   formatUTCOffset(offsetSec),
		DateTime: target.Format(time.RFC3339),
		Date:     target.Format("2006-01-02"),
		Time:     target.Format("15:04:05"),
		Weekday:  target.Weekday().String(),
		Unix:     target.Unix(),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return plugin.MCPCallToolResult{
			IsError: true,
			Content: []plugin.MCPToolContent{{Type: "text", Text: fmt.Sprintf("encode time payload: %v", err)}},
		}
	}
	return plugin.MCPCallToolResult{
		Content:           []plugin.MCPToolContent{{Type: "text", Text: string(encoded)}},
		StructuredContent: encoded,
	}
}

func resolveBuiltinTimezone(raw string) (*time.Location, error) {
	tz := strings.TrimSpace(raw)
	if tz == "" {
		return time.Local, nil
	}
	upper := strings.ToUpper(tz)
	if upper == "UTC" || upper == "GMT" || upper == "Z" {
		return time.UTC, nil
	}
	if loc, ok := parseFixedUTCOffset(upper); ok {
		return loc, nil
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc, nil
	}
	return nil, fmt.Errorf("invalid timezone %q: expected an IANA timezone name (e.g. 'Asia/Shanghai') or UTC offset (e.g. '+08:00')", tz)
}

func parseFixedUTCOffset(upper string) (*time.Location, bool) {
	s := strings.TrimSpace(upper)
	for _, prefix := range []string{"UTC", "GMT"} {
		if strings.HasPrefix(s, prefix) {
			s = strings.TrimSpace(s[len(prefix):])
			break
		}
	}
	if len(s) < 2 || (s[0] != '+' && s[0] != '-') {
		return nil, false
	}
	sign := 1
	signChar := '+'
	if s[0] == '-' {
		sign = -1
		signChar = '-'
	}
	rest := s[1:]

	var hh, mm int
	if strings.Contains(rest, ":") {
		hStr, mStr, ok := strings.Cut(rest, ":")
		if !ok || len(hStr) < 1 || len(hStr) > 2 || len(mStr) != 2 {
			return nil, false
		}
		var err error
		if hh, err = parseNonNegDigits(hStr); err != nil {
			return nil, false
		}
		if mm, err = parseNonNegDigits(mStr); err != nil {
			return nil, false
		}
	} else if len(rest) == 4 {
		var err error
		if hh, err = parseNonNegDigits(rest[:2]); err != nil {
			return nil, false
		}
		if mm, err = parseNonNegDigits(rest[2:]); err != nil {
			return nil, false
		}
	} else if len(rest) == 1 || len(rest) == 2 {
		var err error
		if hh, err = parseNonNegDigits(rest); err != nil {
			return nil, false
		}
	} else {
		return nil, false
	}

	if hh > 14 || mm >= 60 || (hh == 14 && mm > 0) {
		return nil, false
	}
	offsetSec := sign * (hh*3600 + mm*60)
	label := fmt.Sprintf("UTC%c%02d:%02d", signChar, hh, mm)
	return time.FixedZone(label, offsetSec), true
}

func parseNonNegDigits(s string) (int, error) {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("non-digit")
		}
	}
	return strconv.Atoi(s)
}

func formatUTCOffset(offsetSec int) string {
	sign := '+'
	if offsetSec < 0 {
		sign = '-'
		offsetSec = -offsetSec
	}
	hours := offsetSec / 3600
	mins := (offsetSec % 3600) / 60
	return fmt.Sprintf("%c%02d:%02d", sign, hours, mins)
}
