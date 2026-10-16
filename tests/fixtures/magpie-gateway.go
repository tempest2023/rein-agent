// Run only from the reviewed Magpie source module by verify-subscriptions.mjs.
// Its upstream test helpers isolate credential stores/keychains and refuse
// non-loopback requests. No installed Magpie profile or native login is used.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/testenv"
)

func main() {
	upstream := flag.String("upstream", "", "synthetic loopback upstream")
	flag.Parse()
	u, err := url.Parse(*upstream)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		panic("loopback fixture upstream required")
	}
	isolated, err := testenv.Isolate()
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(isolated)
	defer testenv.RemovePrograms()
	testenv.Offline()
	models := []string{}
	// Deliberately configure a hidden extra provider behind Google's fallback.
	// The managed caller key must prevent it from ever receiving a request.
	if err := provider.Save(provider.Provider{ID: "rein-fixture-payg", Name: "Synthetic excluded paid route", Key: "synthetic-excluded-key", Chat: strings.TrimRight(*upstream, "/") + "/v1", Models: []string{"payg"}}); err != nil {
		panic(err)
	}
	for _, id := range []string{"openai", "claude", "google", "bailian"} {
		p := provider.Provider{ID: "rein-fixture-" + id, Name: "Synthetic " + id, Key: "synthetic-upstream-key", Chat: strings.TrimRight(*upstream, "/") + "/v1", Models: []string{id}}
		if id == "google" {
			p.Fallback = []string{"rein-fixture-payg/payg"}
		}
		if err := provider.Save(p); err != nil {
			panic(err)
		}
		models = append(models, p.ID+"/"+id)
	}
	secret, err := access.Update("add-key", access.Change{Name: "Rein hermetic probe"})
	if err != nil {
		panic(err)
	}
	who, ok := access.Authenticate(secret)
	if !ok {
		panic("fixture key creation failed")
	}
	if _, err := access.Update("models-key", access.Change{Key: who.KeyID, Models: models}); err != nil {
		panic(err)
	}
	server := httptest.NewServer(gateway.New().Handler())
	defer server.Close()
	ready, _ := json.Marshal(map[string]any{"baseUrl": server.URL + "/v1", "apiKey": secret})
	fmt.Println("REIN_MAGPIE_FIXTURE_READY " + string(ready))
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
}
