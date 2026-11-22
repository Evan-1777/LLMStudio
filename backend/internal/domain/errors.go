package domain

import (
	"errors"
	"fmt"
	"net/http"
)

// Standard API and domain error codes.
const (
	ErrCodeUnauthorized      = "UNAUTHORIZED"
	ErrCodeNotFound          = "NOT_FOUND"
	ErrCodeInvalidArgument   = "INVALID_ARGUMENT"
	ErrCodeConflict          = "CONFLICT"
	ErrCodePayloadTooLarge   = "PAYLOAD_TOO_LARGE"
	ErrCodeUpstreamError     = "UPSTREAM_ERROR"
	ErrCodeCloudNotConnected = "CLOUD_NOT_CONNECTED"
	ErrCodeInternalError     = "INTERNAL_ERROR"
)

// AppError represents a structured domain or gateway error mapped to an HTTP status.
type AppError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Err     error  `json:"-"`
}

func (e *AppError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AppError) Unwrap() error {
	return e.Err
}

// HTTPStatus maps the error code to the corresponding HTTP response status.
func (e *AppError) HTTPStatus() int {
	switch e.Code {
	case ErrCodeUnauthorized:
		return http.StatusUnauthorized
	case ErrCodeNotFound:
		return http.StatusNotFound
	case ErrCodeInvalidArgument:
		return http.StatusBadRequest
	case ErrCodeConflict:
		return http.StatusConflict
	case ErrCodePayloadTooLarge:
		return http.StatusRequestEntityTooLarge
	case ErrCodeUpstreamError:
		return http.StatusBadGateway
	case ErrCodeCloudNotConnected:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

// NewError creates a structured AppError.
func NewError(code, message string, err error) *AppError {
	return &AppError{Code: code, Message: message, Err: err}
}

// AsAppError extracts an AppError from err if present.
func AsAppError(err error) (*AppError, bool) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr, true
	}
	return nil, false
}
