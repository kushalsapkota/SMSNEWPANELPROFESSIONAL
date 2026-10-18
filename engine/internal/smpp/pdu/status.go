package pdu

import "fmt"

// CommandStatus is the SMPP v3.4 command_status field (section 5.1.3).
// ESME_ROK (0) means success; every other value is an error code.
type CommandStatus uint32

// SMPP v3.4 command_status values. Names follow the specification so they are
// greppable against the spec and against peer logs.
//
//revive:disable:var-naming
const (
	ESME_ROK              CommandStatus = 0x00000000 // No error
	ESME_RINVMSGLEN       CommandStatus = 0x00000001 // Message length is invalid
	ESME_RINVCMDLEN       CommandStatus = 0x00000002 // Command length is invalid
	ESME_RINVCMDID        CommandStatus = 0x00000003 // Invalid command ID
	ESME_RINVBNDSTS       CommandStatus = 0x00000004 // Incorrect BIND status for given command
	ESME_RALYBND          CommandStatus = 0x00000005 // ESME already in bound state
	ESME_RINVPRTFLG       CommandStatus = 0x00000006 // Invalid priority flag
	ESME_RINVREGDLVFLG    CommandStatus = 0x00000007 // Invalid registered delivery flag
	ESME_RSYSERR          CommandStatus = 0x00000008 // System error
	ESME_RINVSRCADR       CommandStatus = 0x0000000A // Invalid source address
	ESME_RINVDSTADR       CommandStatus = 0x0000000B // Invalid destination address
	ESME_RINVMSGID        CommandStatus = 0x0000000C // Message ID is invalid
	ESME_RBINDFAIL        CommandStatus = 0x0000000D // Bind failed
	ESME_RINVPASWD        CommandStatus = 0x0000000E // Invalid password
	ESME_RINVSYSID        CommandStatus = 0x0000000F // Invalid system ID
	ESME_RCANCELFAIL      CommandStatus = 0x00000011 // cancel_sm failed
	ESME_RREPLACEFAIL     CommandStatus = 0x00000013 // replace_sm failed
	ESME_RMSGQFUL         CommandStatus = 0x00000014 // Message queue full
	ESME_RINVSERTYP       CommandStatus = 0x00000015 // Invalid service type
	ESME_RINVNUMDESTS     CommandStatus = 0x00000033 // Invalid number of destinations
	ESME_RINVDLNAME       CommandStatus = 0x00000034 // Invalid distribution list name
	ESME_RINVDESTFLAG     CommandStatus = 0x00000040 // Destination flag is invalid (submit_multi)
	ESME_RINVSUBREP       CommandStatus = 0x00000042 // Invalid submit with replace request
	ESME_RINVESMCLASS     CommandStatus = 0x00000043 // Invalid esm_class field data
	ESME_RCNTSUBDL        CommandStatus = 0x00000044 // Cannot submit to distribution list
	ESME_RSUBMITFAIL      CommandStatus = 0x00000045 // submit_sm or submit_multi failed
	ESME_RINVSRCTON       CommandStatus = 0x00000048 // Invalid source address TON
	ESME_RINVSRCNPI       CommandStatus = 0x00000049 // Invalid source address NPI
	ESME_RINVDSTTON       CommandStatus = 0x00000050 // Invalid destination address TON
	ESME_RINVDSTNPI       CommandStatus = 0x00000051 // Invalid destination address NPI
	ESME_RINVSYSTYP       CommandStatus = 0x00000053 // Invalid system_type field
	ESME_RINVREPFLAG      CommandStatus = 0x00000054 // Invalid replace_if_present flag
	ESME_RINVNUMMSGS      CommandStatus = 0x00000055 // Invalid number of messages
	ESME_RTHROTTLED       CommandStatus = 0x00000058 // Throttling error (ESME exceeded allowed message limits)
	ESME_RINVSCHED        CommandStatus = 0x00000061 // Invalid scheduled delivery time
	ESME_RINVEXPIRY       CommandStatus = 0x00000062 // Invalid message validity period
	ESME_RINVDFTMSGID     CommandStatus = 0x00000063 // Predefined message invalid or not found
	ESME_RX_T_APPN        CommandStatus = 0x00000064 // ESME receiver temporary app error
	ESME_RX_P_APPN        CommandStatus = 0x00000065 // ESME receiver permanent app error
	ESME_RX_R_APPN        CommandStatus = 0x00000066 // ESME receiver reject message error
	ESME_RQUERYFAIL       CommandStatus = 0x00000067 // query_sm request failed
	ESME_RINVOPTPARSTREAM CommandStatus = 0x000000C0 // Error in the optional part of the PDU body
	ESME_ROPTPARNOTALLWD  CommandStatus = 0x000000C1 // Optional parameter not allowed
	ESME_RINVPARLEN       CommandStatus = 0x000000C2 // Invalid parameter length
	ESME_RMISSINGOPTPARAM CommandStatus = 0x000000C3 // Expected optional parameter missing
	ESME_RINVOPTPARAMVAL  CommandStatus = 0x000000C4 // Invalid optional parameter value
	ESME_RDELIVERYFAILURE CommandStatus = 0x000000FE // Delivery failure (data_sm_resp)
	ESME_RUNKNOWNERR      CommandStatus = 0x000000FF // Unknown error
	// ESME_RINVDCS (SMPP v5.0; widely used with v3.4 too): invalid or
	// unsupported data_coding.
	ESME_RINVDCS CommandStatus = 0x00000104
)

//revive:enable:var-naming

var statusNames = map[CommandStatus]string{
	ESME_ROK: "ESME_ROK", ESME_RINVMSGLEN: "ESME_RINVMSGLEN", ESME_RINVCMDLEN: "ESME_RINVCMDLEN",
	ESME_RINVCMDID: "ESME_RINVCMDID", ESME_RINVBNDSTS: "ESME_RINVBNDSTS", ESME_RALYBND: "ESME_RALYBND",
	ESME_RINVPRTFLG: "ESME_RINVPRTFLG", ESME_RINVREGDLVFLG: "ESME_RINVREGDLVFLG", ESME_RSYSERR: "ESME_RSYSERR",
	ESME_RINVSRCADR: "ESME_RINVSRCADR", ESME_RINVDSTADR: "ESME_RINVDSTADR", ESME_RINVMSGID: "ESME_RINVMSGID",
	ESME_RBINDFAIL: "ESME_RBINDFAIL", ESME_RINVPASWD: "ESME_RINVPASWD", ESME_RINVSYSID: "ESME_RINVSYSID",
	ESME_RCANCELFAIL: "ESME_RCANCELFAIL", ESME_RREPLACEFAIL: "ESME_RREPLACEFAIL", ESME_RMSGQFUL: "ESME_RMSGQFUL",
	ESME_RINVSERTYP: "ESME_RINVSERTYP", ESME_RINVNUMDESTS: "ESME_RINVNUMDESTS", ESME_RINVDLNAME: "ESME_RINVDLNAME",
	ESME_RINVDESTFLAG: "ESME_RINVDESTFLAG", ESME_RINVSUBREP: "ESME_RINVSUBREP", ESME_RINVESMCLASS: "ESME_RINVESMCLASS",
	ESME_RCNTSUBDL: "ESME_RCNTSUBDL", ESME_RSUBMITFAIL: "ESME_RSUBMITFAIL", ESME_RINVSRCTON: "ESME_RINVSRCTON",
	ESME_RINVSRCNPI: "ESME_RINVSRCNPI", ESME_RINVDSTTON: "ESME_RINVDSTTON", ESME_RINVDSTNPI: "ESME_RINVDSTNPI",
	ESME_RINVSYSTYP: "ESME_RINVSYSTYP", ESME_RINVREPFLAG: "ESME_RINVREPFLAG", ESME_RINVNUMMSGS: "ESME_RINVNUMMSGS",
	ESME_RTHROTTLED: "ESME_RTHROTTLED", ESME_RINVSCHED: "ESME_RINVSCHED", ESME_RINVEXPIRY: "ESME_RINVEXPIRY",
	ESME_RINVDFTMSGID: "ESME_RINVDFTMSGID", ESME_RX_T_APPN: "ESME_RX_T_APPN", ESME_RX_P_APPN: "ESME_RX_P_APPN",
	ESME_RX_R_APPN: "ESME_RX_R_APPN", ESME_RQUERYFAIL: "ESME_RQUERYFAIL", ESME_RINVOPTPARSTREAM: "ESME_RINVOPTPARSTREAM",
	ESME_ROPTPARNOTALLWD: "ESME_ROPTPARNOTALLWD", ESME_RINVPARLEN: "ESME_RINVPARLEN", ESME_RMISSINGOPTPARAM: "ESME_RMISSINGOPTPARAM",
	ESME_RINVOPTPARAMVAL: "ESME_RINVOPTPARAMVAL", ESME_RDELIVERYFAILURE: "ESME_RDELIVERYFAILURE", ESME_RUNKNOWNERR: "ESME_RUNKNOWNERR",
	ESME_RINVDCS: "ESME_RINVDCS",
}

// String returns the spec name (e.g. "ESME_RTHROTTLED") or a hex value for
// vendor-specific codes.
func (s CommandStatus) String() string {
	if n, ok := statusNames[s]; ok {
		return n
	}
	return fmt.Sprintf("0x%08X", uint32(s))
}

// OK reports whether s is ESME_ROK.
func (s CommandStatus) OK() bool { return s == ESME_ROK }

// StatusError is returned by request helpers when the peer answered with a
// non-zero command_status (or a generic_nack). The response PDU, when there is
// one, is usually returned alongside it.
type StatusError struct {
	Command CommandID     // the response command (e.g. CmdSubmitSMResp or CmdGenericNack)
	Status  CommandStatus // the peer's command_status
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("smpp: %s: %s (0x%08X)", e.Command, e.Status, uint32(e.Status))
}
