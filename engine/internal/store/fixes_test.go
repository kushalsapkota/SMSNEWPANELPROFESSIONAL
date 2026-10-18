package store

import "testing"

// Per-message fields and max_tps are reported as updates but do not need
// a rebind; session fields do.
func TestSessionConfigEqualOnlyCoversRebindFields(t *testing.T) {
	base := &Connection{ID: "a", Name: "n", Host: "h", Port: 1, SystemID: "s", Password: "p", BindType: "TRX", Sessions: 2,
		MaxTPS: 10, WindowSize: 5, MultipartMode: "UDH", Enabled: true}
	inPlace := *base
	inPlace.Name, inPlace.MaxTPS, inPlace.RequestDLR, inPlace.MultipartMode, inPlace.DefaultDataCoding = "m", 50, true, "SAR", 1
	if !base.SessionConfigEqual(&inPlace) || base.ConfigEqual(&inPlace) {
		t.Fatal("per-message / TPS fields must not require a rebind but must count as a change")
	}
	d := DiffConnections(NewSnapshot(Data{Connections: []*Connection{base}}), NewSnapshot(Data{Connections: []*Connection{&inPlace}}))
	if len(d.Updated) != 1 {
		t.Fatalf("diff %v", d)
	}
	for _, mut := range []func(c *Connection){
		func(c *Connection) { c.Port = 2 }, func(c *Connection) { c.Password = "x" }, func(c *Connection) { c.Sessions = 3 },
		func(c *Connection) { c.WindowSize = 9 }, func(c *Connection) { c.Enabled = false }, func(c *Connection) { c.BindType = "TX" },
	} {
		c := *base
		mut(&c)
		if base.SessionConfigEqual(&c) {
			t.Fatalf("session change not detected: %+v", c)
		}
	}
}
