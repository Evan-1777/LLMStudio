package service

import (
	"fmt"
	"slices"
	"time"
)

// ComputeNextScheduleRun computes the earliest UTC timestamp strictly after now matching
// hour:minute on allowed weekdays (empty slice means every day) in timezone.
func ComputeNextScheduleRun(now time.Time, hour, minute int, weekdays []int, timezone string) (*time.Time, error) {
	if hour < 0 || hour > 23 {
		return nil, fmt.Errorf("invalid hour %d", hour)
	}
	if minute < 0 || minute > 59 {
		return nil, fmt.Errorf("invalid minute %d", minute)
	}
	loc, err := resolveBuiltinTimezone(timezone)
	if err != nil {
		return nil, err
	}

	refUTC := now.UTC()
	localNow := refUTC.In(loc)
	year, month, day := localNow.Date()

	for offset := 0; offset <= 7; offset++ {
		candidate := time.Date(year, month, day+offset, hour, minute, 0, 0, loc)
		if !candidate.UTC().After(refUTC) {
			continue
		}
		if len(weekdays) > 0 && !slices.Contains(weekdays, int(candidate.Weekday())) {
			continue
		}
		next := candidate.UTC()
		return &next, nil
	}
	return nil, fmt.Errorf("failed to compute next schedule run")
}
