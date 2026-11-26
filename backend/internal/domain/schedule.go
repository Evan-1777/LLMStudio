package domain

import (
	"fmt"
	"slices"
	"time"
)

// Schedule bind modes.
const (
	ScheduleBindModeNew          = "new"
	ScheduleBindModeConversation = "conversation"
)

// Schedule run status values.
const (
	ScheduleStatusRunning   = "running"
	ScheduleStatusSucceeded = "succeeded"
	ScheduleStatusFailed    = "failed"
	ScheduleStatusSkipped   = "skipped"
)

// ScheduledTask represents a cloud-only alarm-style Agent scheduled task.
type ScheduledTask struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	Prompt             string     `json:"prompt"`
	Enabled            bool       `json:"enabled"`
	Hour               int        `json:"hour"`
	Minute             int        `json:"minute"`
	Weekdays           []int      `json:"weekdays"`
	Timezone           string     `json:"timezone"`
	MaxRuns            int        `json:"maxRuns"`
	RunCount           int        `json:"runCount"`
	BindMode           string     `json:"bindMode"`
	ConversationID     *string    `json:"conversationId,omitempty"`
	ConversationTitle  string     `json:"conversationTitle,omitempty"`
	AssistantID        string     `json:"assistantId"`
	ProviderID         string     `json:"providerId"`
	ModelID            string     `json:"modelId"`
	NextRunAt          *time.Time `json:"nextRunAt,omitempty"`
	LastRunAt          *time.Time `json:"lastRunAt,omitempty"`
	LastStatus         string     `json:"lastStatus"`
	LastError          string     `json:"lastError,omitempty"`
	LastConversationID string     `json:"lastConversationId,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

// ScheduleCreateInput defines fields accepted when creating a scheduled task.
type ScheduleCreateInput struct {
	Name           string  `json:"name"`
	Prompt         string  `json:"prompt"`
	Enabled        *bool   `json:"enabled,omitempty"`
	Hour           int     `json:"hour"`
	Minute         int     `json:"minute"`
	Weekdays       []int   `json:"weekdays,omitempty"`
	Timezone       string  `json:"timezone,omitempty"`
	MaxRuns        int     `json:"maxRuns,omitempty"`
	BindMode       string  `json:"bindMode,omitempty"`
	ConversationID *string `json:"conversationId,omitempty"`
	AssistantID    string  `json:"assistantId,omitempty"`
	ProviderID     string  `json:"providerId,omitempty"`
	ModelID        string  `json:"modelId,omitempty"`
}

// ScheduleUpdateInput defines fields accepted when patching an existing scheduled task.
type ScheduleUpdateInput struct {
	Name           *string `json:"name,omitempty"`
	Prompt         *string `json:"prompt,omitempty"`
	Enabled        *bool   `json:"enabled,omitempty"`
	Hour           *int    `json:"hour,omitempty"`
	Minute         *int    `json:"minute,omitempty"`
	Weekdays       *[]int  `json:"weekdays,omitempty"`
	Timezone       *string `json:"timezone,omitempty"`
	MaxRuns        *int    `json:"maxRuns,omitempty"`
	ResetRunCount  *bool   `json:"resetRunCount,omitempty"`
	BindMode       *string `json:"bindMode,omitempty"`
	ConversationID *string `json:"conversationId,omitempty"`
	AssistantID    *string `json:"assistantId,omitempty"`
	ProviderID     *string `json:"providerId,omitempty"`
	ModelID        *string `json:"modelId,omitempty"`
}

// NormalizeWeekdays validates weekday values (0=Sunday..6=Saturday), deduplicates and sorts them,
// and collapses all 7 days into an empty slice representing daily execution.
func NormalizeWeekdays(days []int) ([]int, error) {
	if len(days) == 0 {
		return []int{}, nil
	}
	seen := make(map[int]struct{}, len(days))
	out := make([]int, 0, len(days))
	for _, d := range days {
		if d < 0 || d > 6 {
			return nil, NewError(ErrCodeInvalidArgument, fmt.Sprintf("invalid weekday %d: must be 0..6", d), nil)
		}
		if _, dup := seen[d]; dup {
			continue
		}
		seen[d] = struct{}{}
		out = append(out, d)
	}
	if len(out) == 7 {
		return []int{}, nil
	}
	slices.Sort(out)
	return out, nil
}

// ValidateScheduleTime validates alarm clock hour (0..23) and minute (0..59).
func ValidateScheduleTime(hour, minute int) error {
	if hour < 0 || hour > 23 {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("invalid hour %d: must be 0..23", hour), nil)
	}
	if minute < 0 || minute > 59 {
		return NewError(ErrCodeInvalidArgument, fmt.Sprintf("invalid minute %d: must be 0..59", minute), nil)
	}
	return nil
}
