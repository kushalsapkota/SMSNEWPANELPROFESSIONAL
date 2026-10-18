//go:build tools

// Pins the module's third-party dependencies so parallel work never races on go.mod.
package tools

import (
	_ "github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/redis/go-redis/v9"
	_ "golang.org/x/crypto/argon2"
	_ "golang.org/x/time/rate"
)
