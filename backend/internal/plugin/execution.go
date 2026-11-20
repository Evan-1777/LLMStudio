package plugin

// ExecutionScope identifies where a runtime resource or tool executes.
type ExecutionScope string

const (
	ExecutionScopeLocal ExecutionScope = "local"
	ExecutionScopeCloud ExecutionScope = "cloud"
)

// ValidExecutionScope reports whether scope is one of the supported execution domains.
func ValidExecutionScope(scope ExecutionScope) bool {
	return scope == ExecutionScopeLocal || scope == ExecutionScopeCloud
}
