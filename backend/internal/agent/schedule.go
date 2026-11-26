package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

// ScheduleManager provides cloud-only scheduled task operations to the Agent runtime.
type ScheduleManager interface {
	List(ctx context.Context, conversationID string) ([]domain.ScheduledTask, error)
	CreateFromTopic(ctx context.Context, topicID string, bindCurrent bool, in domain.ScheduleCreateInput) (domain.ScheduledTask, error)
	Update(ctx context.Context, id string, in domain.ScheduleUpdateInput) (domain.ScheduledTask, error)
	Delete(ctx context.Context, id string) error
}

func scheduleTool() plugin.ChatTool {
	rawSchema, _ := json.Marshal(map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"action"},
		"properties": map[string]any{
			"action": map[string]any{
				"type":        "string",
				"enum":        []string{"list", "create", "update", "delete"},
				"description": "Operation to perform on scheduled tasks.",
			},
			"current_topic_only": map[string]any{
				"type":        "boolean",
				"description": "For list: filter schedules bound to the current conversation.",
			},
			"id": map[string]any{
				"type":        "string",
				"description": "Scheduled task ID (required for update and delete).",
			},
			"name": map[string]any{
				"type":        "string",
				"description": "Task name (required for create).",
			},
			"prompt": map[string]any{
				"type":        "string",
				"description": "Prompt delivered to the Agent when triggered (required for create).",
			},
			"hour": map[string]any{
				"type":        "integer",
				"description": "Trigger hour in 24h clock (0-23, required for create).",
			},
			"minute": map[string]any{
				"type":        "integer",
				"description": "Trigger minute (0-59, required for create).",
			},
			"weekdays": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "integer"},
				"description": "Days of week (0=Sunday..6=Saturday). Empty or omitted means every day.",
			},
			"timezone": map[string]any{
				"type":        "string",
				"description": "IANA timezone name (e.g. 'Asia/Shanghai') or UTC offset.",
			},
			"max_runs": map[string]any{
				"type":        "integer",
				"description": "Maximum automatic executions (0 means unlimited).",
			},
			"enabled": map[string]any{
				"type":        "boolean",
				"description": "Whether the schedule is active.",
			},
			"bind_current_topic": map[string]any{
				"type":        "boolean",
				"description": "For create: true (default) binds this conversation; false creates a new Agent topic on each run.",
			},
			"reset_run_count": map[string]any{
				"type":        "boolean",
				"description": "For update: reset runCount back to 0.",
			},
		},
	})
	return plugin.ChatTool{
		Alias:       "schedule",
		Description: "Manage cloud Agent alarm-style scheduled tasks (list, create, update, delete). By default, create binds the current conversation for scheduled wakeups.",
		InputSchema: rawSchema,
	}
}

type scheduleToolArgs struct {
	Action           string  `json:"action"`
	CurrentTopicOnly *bool   `json:"current_topic_only"`
	ID               string  `json:"id"`
	Name             *string `json:"name"`
	Prompt           *string `json:"prompt"`
	Hour             *int    `json:"hour"`
	Minute           *int    `json:"minute"`
	Weekdays         *[]int  `json:"weekdays"`
	Timezone         *string `json:"timezone"`
	MaxRuns          *int    `json:"max_runs"`
	Enabled          *bool   `json:"enabled"`
	BindCurrentTopic *bool   `json:"bind_current_topic"`
	ResetRunCount    *bool   `json:"reset_run_count"`
}

func (a *Runtime) runSchedule(ctx context.Context, topicID string, raw json.RawMessage) (string, error) {
	if !a.gateway || a.scheduler == nil {
		return "", errors.New("schedule tool is only available on cloud gateway")
	}
	var args scheduleToolArgs
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil {
		return "", errors.New("invalid schedule tool arguments")
	}

	switch strings.TrimSpace(args.Action) {
	case "list":
		filterConv := ""
		if args.CurrentTopicOnly != nil && *args.CurrentTopicOnly {
			filterConv = topicID
		}
		tasks, err := a.scheduler.List(ctx, filterConv)
		if err != nil {
			return "", err
		}
		return marshalToolJSON(map[string]any{"schedules": tasks})

	case "create":
		if args.Name == nil || strings.TrimSpace(*args.Name) == "" {
			return "", errors.New("name is required for schedule create")
		}
		if args.Prompt == nil || strings.TrimSpace(*args.Prompt) == "" {
			return "", errors.New("prompt is required for schedule create")
		}
		if args.Hour == nil || args.Minute == nil {
			return "", errors.New("hour and minute are required for schedule create")
		}
		bindCurrent := true
		if args.BindCurrentTopic != nil {
			bindCurrent = *args.BindCurrentTopic
		}
		in := domain.ScheduleCreateInput{
			Name:    *args.Name,
			Prompt:  *args.Prompt,
			Enabled: args.Enabled,
			Hour:    *args.Hour,
			Minute:  *args.Minute,
		}
		if args.Weekdays != nil {
			in.Weekdays = *args.Weekdays
		}
		if args.Timezone != nil {
			in.Timezone = *args.Timezone
		}
		if args.MaxRuns != nil {
			in.MaxRuns = *args.MaxRuns
		}
		created, err := a.scheduler.CreateFromTopic(ctx, topicID, bindCurrent, in)
		if err != nil {
			return "", err
		}
		return marshalToolJSON(map[string]any{"schedule": created})

	case "update":
		id := strings.TrimSpace(args.ID)
		if id == "" {
			return "", errors.New("id is required for schedule update")
		}
		updated, err := a.scheduler.Update(ctx, id, domain.ScheduleUpdateInput{
			Name:          args.Name,
			Prompt:        args.Prompt,
			Enabled:       args.Enabled,
			Hour:          args.Hour,
			Minute:        args.Minute,
			Weekdays:      args.Weekdays,
			Timezone:      args.Timezone,
			MaxRuns:       args.MaxRuns,
			ResetRunCount: args.ResetRunCount,
		})
		if err != nil {
			return "", err
		}
		return marshalToolJSON(map[string]any{"schedule": updated})

	case "delete":
		id := strings.TrimSpace(args.ID)
		if id == "" {
			return "", errors.New("id is required for schedule delete")
		}
		if err := a.scheduler.Delete(ctx, id); err != nil {
			return "", err
		}
		return marshalToolJSON(map[string]any{"deleted": true, "id": id})

	default:
		return "", errors.New("unknown schedule action: expected list, create, update, or delete")
	}
}

func marshalToolJSON(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
