// Package e2e holds the engine's end-to-end tests: two smsc-sim upstreams
// and the full engine (app.New) run against Postgres sms_flow and Redis
// db 2, driven through the internal HTTP API and the client SMPP server.
//
//	go test ./e2e/ -v
//
// Override the services with E2E_DATABASE_URL / E2E_REDIS_URL. When the
// sms_flow database does not exist and db/reset-db.sh is runnable (root),
// it is created automatically.
package e2e
