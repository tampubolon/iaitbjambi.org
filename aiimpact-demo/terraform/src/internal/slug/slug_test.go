package slug

import "testing"

func TestMake(t *testing.T) {
	cases := map[string]string{
		"Warung Nasi Goreng Budi": "warung-nasi-goreng-budi",
		"  Kopi   Kita  ":         "kopi-kita",
		"Ayam Geprek 99":          "ayam-geprek-99",
		"Toko-Bunga_Melati":       "toko-bunga-melati",
		"Rendang Uni Ana!!!":      "rendang-uni-ana",
		"Es Teh ☕ Segar":          "es-teh-segar",
		"CV. Maju Jaya, Tbk":      "cv-maju-jaya-tbk",
	}
	for in, want := range cases {
		got, err := Make(in)
		if err != nil {
			t.Errorf("Make(%q) error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("Make(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMakeRejectsUnusable(t *testing.T) {
	for _, in := range []string{"", "   ", "!!!", "---", "123", "456 789"} {
		if got, err := Make(in); err == nil {
			t.Errorf("Make(%q) = %q, want an error", in, got)
		}
	}
}

func TestMakeTrimsToMaxLen(t *testing.T) {
	long := "warung makan sederhana bu ani yang sangat terkenal di seluruh kota jambi"
	got, err := Make(long)
	if err != nil {
		t.Fatalf("Make: %v", err)
	}
	if len(got) > MaxLen {
		t.Errorf("len(%q) = %d, want <= %d", got, len(got), MaxLen)
	}
	if got[len(got)-1] == '-' {
		t.Errorf("Make(%q) = %q, must not end in a hyphen", long, got)
	}
}

func TestUniqueAppendsSuffix(t *testing.T) {
	taken := map[string]bool{"kopi-kita": true, "kopi-kita-2": true}
	got, err := Unique("Kopi Kita", func(c string) (bool, error) { return !taken[c], nil })
	if err != nil {
		t.Fatalf("Unique: %v", err)
	}
	if got != "kopi-kita-3" {
		t.Errorf("Unique = %q, want kopi-kita-3", got)
	}
}

func TestUniqueSkipsReserved(t *testing.T) {
	got, err := Unique("API", func(string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatalf("Unique: %v", err)
	}
	if got == "api" {
		t.Error("Unique returned a reserved label")
	}
	if got != "api-2" {
		t.Errorf("Unique = %q, want api-2", got)
	}
}
