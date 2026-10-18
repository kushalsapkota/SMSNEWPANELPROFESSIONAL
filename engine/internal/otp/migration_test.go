package otp

import (
	"os"
	"path/filepath"
)

func readMigration() (string, error) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "db", "migrations", "005_otp_patterns.sql"))
	return string(b), err
}
