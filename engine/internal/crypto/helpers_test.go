package crypto

import "golang.org/x/crypto/argon2"

func argon2IDForTest(pw string, salt []byte, t, m uint32, p uint8, l uint32) []byte {
	return argon2.IDKey([]byte(pw), salt, t, m, p, l)
}
