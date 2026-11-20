package desktop

import (
	"bytes"
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

type dpapiProtector struct{}

// PlatformCredentialProtector uses Windows DPAPI in current-user scope.
func PlatformCredentialProtector() CredentialProtector { return dpapiProtector{} }

func (dpapiProtector) Protect(data []byte) ([]byte, error)   { return dpapi(data, true) }
func (dpapiProtector) Unprotect(data []byte) ([]byte, error) { return dpapi(data, false) }

func dpapi(data []byte, protect bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty DPAPI input")
	}
	input := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var output windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	} else {
		err = windows.CryptUnprotectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	result := unsafe.Slice(output.Data, output.Size)
	defer clear(result)
	return bytes.Clone(result), nil
}
