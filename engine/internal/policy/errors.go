// Package policy holds the engine-wide error code enum (CONTRACTS §4), the
// typed *Error that carries those codes through every layer, and the
// pipeline policy checks (channel state, sender, blocklists) evaluated against
// a config snapshot.
//
// Every engine package that rejects a message returns a *policy.Error so the
// HTTP layer can emit {"error_code","message"} and the SMPP layer can map the
// code to a command_status without string matching.
package policy

import (
	"errors"
	"fmt"
	"net/http"
)

// Code is one of the CONTRACTS §4 error codes. The string value is exactly
// what the HTTP API returns as `error_code`.
type Code string

const (
	CodeInvalidRequest     Code = "INVALID_REQUEST"
	CodeUnauthorized       Code = "UNAUTHORIZED"
	CodeForbidden          Code = "FORBIDDEN"
	CodeIPNotAllowed       Code = "IP_NOT_ALLOWED"
	CodeAccountSuspended   Code = "ACCOUNT_SUSPENDED"
	CodeSendingDisabled    Code = "SENDING_DISABLED"
	CodeChannelDisabled    Code = "CHANNEL_DISABLED"
	CodeInsufficientFunds  Code = "INSUFFICIENT_FUNDS"
	CodeRateLimited        Code = "RATE_LIMITED"
	CodeDailyLimit         Code = "DAILY_LIMIT"
	CodeMonthlyLimit       Code = "MONTHLY_LIMIT"
	CodeRouteNotFound      Code = "ROUTE_NOT_FOUND"
	CodeSenderNotAllowed   Code = "SENDER_NOT_ALLOWED"
	CodeOTPNotFound        Code = "OTP_NOT_FOUND"
	CodeDestinationBlocked Code = "DESTINATION_BLOCKED"
	CodeContentBlocked     Code = "CONTENT_BLOCKED"
	CodeContentNotApproved Code = "CONTENT_NOT_APPROVED"
	CodeInvalidDestination Code = "INVALID_DESTINATION"
	CodeMessageTooLong     Code = "MESSAGE_TOO_LONG"
	CodeNotFound           Code = "NOT_FOUND"
	CodeConflict           Code = "CONFLICT"
	CodeInternal           Code = "INTERNAL"
)

// AllCodes lists every code in CONTRACTS order.
var AllCodes = []Code{
	CodeInvalidRequest, CodeUnauthorized, CodeForbidden, CodeIPNotAllowed,
	CodeAccountSuspended, CodeSendingDisabled, CodeChannelDisabled,
	CodeInsufficientFunds, CodeRateLimited, CodeDailyLimit, CodeMonthlyLimit,
	CodeRouteNotFound, CodeSenderNotAllowed, CodeOTPNotFound,
	CodeDestinationBlocked, CodeContentBlocked, CodeContentNotApproved, CodeInvalidDestination,
	CodeMessageTooLong, CodeNotFound, CodeConflict, CodeInternal,
}

// Valid reports whether c is a known code.
func (c Code) Valid() bool {
	for _, k := range AllCodes {
		if k == c {
			return true
		}
	}
	return false
}

// Error is a business rejection (or internal failure) tagged with a code.
// It is immutable and safe to share between goroutines.
type Error struct {
	Code    Code
	Message string
	// Cause is an optional underlying error (never shown to clients).
	Cause error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Cause }

// Is makes errors.Is(err, policy.New(code, "")) match on code alone.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == e.Code && t.Message == "" && t.Cause == nil
}

// New returns an *Error with the given code and client-facing message.
func New(code Code, msg string) *Error { return &Error{Code: code, Message: msg} }

// Errorf formats the client-facing message.
func Errorf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Wrap attaches an internal cause to a coded error.
func Wrap(code Code, msg string, cause error) *Error {
	return &Error{Code: code, Message: msg, Cause: cause}
}

// Sentinel returns a code-only error usable as an errors.Is target:
//
//	errors.Is(err, policy.Sentinel(policy.CodeRouteNotFound))
func Sentinel(code Code) *Error { return &Error{Code: code} }

// CodeOf extracts the code from err; non-policy errors map to INTERNAL and a
// nil error maps to "".
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return CodeInternal
}

// As returns err as *Error, wrapping unknown errors as INTERNAL.
func As(err error) *Error {
	if err == nil {
		return nil
	}
	var pe *Error
	if errors.As(err, &pe) {
		return pe
	}
	return Wrap(CodeInternal, "internal error", err)
}

// HTTPStatus maps a code to the HTTP status the internal/public API uses:
// 400 for malformed requests, 401/403/404/409 for their namesakes, 429 for
// throttling, 500 for INTERNAL and 422 for every other business rejection.
func HTTPStatus(c Code) int {
	switch c {
	case CodeInvalidRequest:
		return http.StatusBadRequest
	case CodeUnauthorized:
		return http.StatusUnauthorized
	case CodeForbidden, CodeIPNotAllowed:
		return http.StatusForbidden
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict:
		return http.StatusConflict
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeInternal, "":
		return http.StatusInternalServerError
	default:
		return http.StatusUnprocessableEntity
	}
}

// SMPP command_status values used by the CONTRACTS §4 mapping.
const (
	SMPPStatusOK          uint32 = 0x00000000
	SMPPStatusInvMsgLen   uint32 = 0x00000001 // ESME_RINVMSGLEN
	SMPPStatusSysErr      uint32 = 0x00000008 // ESME_RSYSERR
	SMPPStatusInvSrcAdr   uint32 = 0x0000000A // ESME_RINVSRCADR
	SMPPStatusInvDstAdr   uint32 = 0x0000000B // ESME_RINVDSTADR
	SMPPStatusBindFail    uint32 = 0x0000000D // ESME_RBINDFAIL
	SMPPStatusInvPaswd    uint32 = 0x0000000E // ESME_RINVPASWD
	SMPPStatusInvSysID    uint32 = 0x0000000F // ESME_RINVSYSID
	SMPPStatusSubmitFail  uint32 = 0x00000045 // ESME_RSUBMITFAIL
	SMPPStatusThrottled   uint32 = 0x00000058 // ESME_RTHROTTLED
	SMPPStatusAlreadyBnd  uint32 = 0x00000005 // ESME_RALYBND
	SMPPStatusInvBindStat uint32 = 0x00000004 // ESME_RINVBNDSTS
)

// SMPPSubmitStatus maps a code to a submit_sm_resp command_status per
// CONTRACTS §4. Unmapped codes become ESME_RSYSERR (INTERNAL) or
// ESME_RSUBMITFAIL (any other business rejection).
func SMPPSubmitStatus(c Code) uint32 {
	switch c {
	case "":
		return SMPPStatusOK
	case CodeRateLimited, CodeDailyLimit, CodeMonthlyLimit:
		return SMPPStatusThrottled
	case CodeSenderNotAllowed:
		return SMPPStatusInvSrcAdr
	case CodeInvalidDestination:
		return SMPPStatusInvDstAdr
	case CodeMessageTooLong:
		return SMPPStatusInvMsgLen
	case CodeInternal:
		return SMPPStatusSysErr
	default:
		// INSUFFICIENT_FUNDS, OTP_NOT_FOUND, ROUTE_NOT_FOUND,
		// DESTINATION_BLOCKED, CONTENT_BLOCKED, ACCOUNT_SUSPENDED,
		// SENDING_DISABLED, CHANNEL_DISABLED, ...
		return SMPPStatusSubmitFail
	}
}

// SMPPBindStatus maps a code to a bind_*_resp command_status per CONTRACTS §4.
func SMPPBindStatus(c Code) uint32 {
	switch c {
	case "":
		return SMPPStatusOK
	case CodeAccountSuspended, CodeSendingDisabled, CodeChannelDisabled:
		return SMPPStatusInvSysID
	case CodeUnauthorized:
		return SMPPStatusInvPaswd
	case CodeIPNotAllowed:
		return SMPPStatusBindFail
	case CodeNotFound:
		return SMPPStatusInvSysID
	case CodeInternal:
		return SMPPStatusSysErr
	default:
		return SMPPStatusBindFail
	}
}
