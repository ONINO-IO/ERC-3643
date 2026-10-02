# T-REX-Stack auf Polygon Mainnet deployen

Polygon-spezifische Schritt-für-Schritt-Anleitung. Alle Werte für Polygon sind schon eingetragen.
Die allgemeine Anleitung mit der vollständigen Fehlertabelle findest du in [DEPLOYMENT.md](./DEPLOYMENT.md).

| | Polygon Mainnet | Amoy Testnet (Generalprobe) |
| --- | --- | --- |
| Chain-ID | **137** (`0x89`) | **80002** (`0x13882`) |
| Native-Token | **POL** | POL (Test-POL, kostenlos) |
| Öffentliche RPC | `https://polygon-bor-rpc.publicnode.com` | `https://polygon-amoy-bor-rpc.publicnode.com` |
| Explorer | https://polygonscan.com | https://amoy.polygonscan.com |
| Kosten für ein Deployment | ca. 29 Mio. Gas × Gaspreis, bei 280 gwei **≈ 8 POL** | 0 € (Test-POL) |
| Dauer | 1–3 Minuten | 1–3 Minuten |

> ⚠️ `https://polygon-rpc.com` ist derzeit **abgeschaltet** (Fehler „API key disabled“). Nicht verwenden.
> Für Mainnet besser einen eigenen RPC-Zugang nutzen (Alchemy, Infura, QuickNode oder dRPC). Die öffentlichen RPCs
> sind rate-limitiert und fallen gelegentlich aus. Das Skript kann dann zwar fortgesetzt werden, aber es nervt.

---

## Checkliste vorab

- [ ] Rechner vorbereitet: [DEPLOYMENT.md, Schritt 0](./DEPLOYMENT.md#schritt-0-einmalig-den-rechner-vorbereiten)
- [ ] **Safe-Multisig auf Polygon** angelegt (wird `TREX_OWNER`), siehe Schritt 1
- [ ] Adresse der **Backend-Wallet** bekannt (wird `GATEWAY_DEPLOYERS`)
- [ ] **Neue Deployer-Wallet** angelegt und mit **POL auf Polygon** aufgeladen, siehe Schritt 2
- [ ] Optional, aber empfohlen: Generalprobe auf Amoy, siehe Schritt 3

---

## Schritt 1: Safe-Multisig auf Polygon anlegen bzw. prüfen

1. https://app.safe.global öffnen, oben rechts als Netzwerk **Polygon** wählen.
2. Bestehenden Safe öffnen oder **Create account** wählen. Owner und Schwelle festlegen, z. B. 2 von 3.
3. Die Safe-Adresse kopieren, das ist dein `TREX_OWNER`.

> ⚠️ Ein Safe, den ihr auf Ethereum oder einer anderen Chain habt, existiert **nicht automatisch** auf Polygon,
> auch wenn die Adresse gleich aussieht. Darum immer prüfen:

```bash
export RPC_URL=https://polygon-bor-rpc.publicnode.com
# Bei einem RPC mit API-Key stattdessen verdeckt eingeben:
#   read -rsp 'RPC_URL: ' RPC_URL && export RPC_URL && echo

curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["<SAFE-ADRESSE>","latest"]}' "$RPC_URL"
```

- `"result":"0x608060..."` (lang) bedeutet: Der Safe existiert auf Polygon. ✅
- `"result":"0x"` bedeutet: kein Contract unter dieser Adresse. ❌ Nicht weitermachen.

Chain-ID gegenprüfen, die Antwort muss `"0x89"` sein:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL"
```

---

## Schritt 2: Deployer-Wallet anlegen und mit POL aufladen

1. **Neue Wallet** in MetaMask anlegen: Kontoauswahl → **Konto hinzufügen** → **Neues Konto**.
   Nur für dieses Deployment verwenden.
2. Private Key exportieren: **⋮** → **Kontodetails** → **Privaten Schlüssel anzeigen**. Brauchst du in Schritt 4.
3. **Benötigte POL berechnen.** Gaspreis abfragen:

   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' "$RPC_URL"
   # {"jsonrpc":"2.0","id":1,"result":"0x40ea245259"}
   node -p "35e6 * 0x40ea245259 / 1e18"       # Hex-Wert aus der Antwort einsetzen
   # 9.69...   <- so viele POL verlangt das Skript mindestens
   ```

4. **Das Doppelte** davon (im Beispiel ca. 20 POL) an die Deployer-Wallet schicken. Der Gaspreis auf Polygon schwankt stark.
   Was übrig bleibt, schickst du danach zurück.

> ⚠️ **Beim Abheben von einer Börse das Netzwerk „Polygon“ / „Polygon PoS“ wählen.**
> Nicht „Ethereum (ERC-20)“ und nicht „Polygon zkEVM“, sonst kommen die POL nicht auf Polygon an.
> Prüfen kannst du das auf https://polygonscan.com: Deployer-Adresse eingeben, dann muss unter **POL Balance** der Betrag stehen.

---

## Schritt 3 (empfohlen): Generalprobe auf Amoy-Testnet

Ein echter Durchlauf auf dem Polygon-Testnet, kostenlos. Du machst einmal alles genau wie in Schritt 4–6, nur mit Testnet-Werten.

1. **Test-POL holen:** Unter https://faucet.polygon.technology Amoy auswählen und die Deployer-Adresse eintragen.
2. **Safe auf Amoy:** Für die Probe reicht eine zweite eigene Wallet-Adresse als `TREX_OWNER`.
   Die Warnung „no contract at this address“ ist dann erwartet.
3. Ab Schritt 4 alles mit diesen Werten:

   ```bash
   export RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com
   EXPECTED_CHAIN_ID=80002
   ```

4. Danach den Ordner `deployments/80002` einfach liegen lassen. Er stört das Mainnet-Deployment nicht.

---

## Schritt 4: Probelauf lokal und Key hinterlegen

Im Ordner `ERC-3643`:

```bash
git pull && npm ci && npx hardhat compile
```

**Probelauf** mit den echten Adressen. Er kostet nichts und sendet nichts an Polygon:

```bash
GATEWAY_DEPLOYERS=<BACKEND-WALLET> \
TREX_OWNER=<SAFE-ADRESSE> \
npx hardhat run scripts/deploy-infra.ts
```

Muss enden mit `Dry run on the in-process hardhat network finished ...` und `TREXGateway (...): 0x...`.
Kommt `invalid address` oder `bad address checksum`, ist eine Adresse falsch kopiert.

**Key hinterlegen:** Die Eingabe erscheint nur als Sternchen.

```bash
npx hardhat vars set DEPLOYER_PRIVATE_KEY
```

---

## Schritt 5: Auf Polygon Mainnet deployen

> ⚠️ Ab hier wird es echt: Das Deployment kostet echte POL und überträgt am Ende die Ownership an den Safe.

`RPC_URL` muss noch aus Schritt 1 gesetzt sein. Hast du ein neues Terminal geöffnet, setz es erneut.

```bash
EXPECTED_CHAIN_ID=137 \
GATEWAY_DEPLOYERS=<BACKEND-WALLET> \
TREX_OWNER=<SAFE-ADRESSE> \
CONFIRMATIONS=3 \
npm run deploy:infra
```

`CONFIRMATIONS=3` wartet pro Transaktion auf 3 Blöcke, auf Polygon sind das etwa 6 Sekunden. Das schützt vor seltenen
Block-Reorgs und verlängert das Deployment nur um 1–2 Minuten.

Das Skript zeigt eine Zusammenfassung. **Jede Zeile prüfen:**

```
About to send REAL transactions:
  Chain              137 via polygon-bor-rpc.publicnode.com     <- muss 137 sein
  Deployer           0x... (balance 20.0, ~9.69 needed)
  TREX_OWNER         0x<SAFE>                                    <- KEINE "WARNING"-Zeile darunter!
  GATEWAY_DEPLOYERS  0x<BACKEND>
  Public gateway     false
  Mode               fresh deployment

Type the chain id (137) to start, anything else aborts:
```

Ist alles korrekt, tippst du **`137`** ein und drückst Enter. Steht unter `TREX_OWNER` eine `WARNING`, drückst du nur Enter
(bricht ab) und prüfst Schritt 1.

Danach laufen 23 Transaktionen durch. Am Ende steht:

```
Deployment record and ABIs: .../deployments/137
TREXGateway (entry point for token suite deployments): 0x...
```

### Polygon-typische Probleme

**Grundregel bei jedem Abbruch:** Denselben Befehl noch einmal ausführen. Das Skript macht dort weiter, wo es aufgehört hat,
und sendet nichts doppelt.

| Was passiert | Bedeutung | Lösung |
| --- | --- | --- |
| Läuft minutenlang nicht weiter | Gaspreis ist gerade stark gestiegen, eine Transaktion hängt | Warten. Wenn du abbrichst (Strg+C), wartet der Neustart auf die hängende Transaktion (Zeile mit `~`) |
| `Deployer balance ... is below the estimated ...` | Gaspreis gestiegen oder zu wenig POL | POL nachschießen, Befehl wiederholen |
| `could not detect network`, `timeout`, `429`, `rate limit` | Öffentlicher RPC überlastet | Kurz warten und wiederholen, oder anderen RPC nehmen (siehe Tabelle oben). Bei RPC-Wechsel denselben Ordner `deployments/137` behalten |
| `RPC reports chain 80002, EXPECTED_CHAIN_ID is 137` (o. ä.) | `RPC_URL` zeigt noch aufs Testnet | `export RPC_URL=` mit der Mainnet-URL setzen |
| `transaction underpriced` / `gas tip cap ... minimum needed` | Priority-Fee unter dem Polygon-Minimum (25 gwei). Das Skript nimmt den vom RPC vorgeschlagenen Wert, ein RPC kann aber zu wenig vorschlagen | Anderen RPC nehmen und wiederholen |

Alle anderen Fehlermeldungen: [Fehlertabelle in DEPLOYMENT.md](./DEPLOYMENT.md#wenn-etwas-schiefgeht).

---

## Schritt 6: Key löschen

```bash
npx hardhat vars delete DEPLOYER_PRIVATE_KEY
npx hardhat vars list          # darf nichts ausgeben
```

Übrige POL von der Deployer-Wallet zurückschicken (MetaMask, Netzwerk Polygon).

---

## Schritt 7: Ergebnis auf Polygonscan prüfen

Die Adressen stehen in `deployments/137/deployment.json`.

1. **TREXGateway** (`factories.TREXGateway.address`) auf https://polygonscan.com suchen. Dort muss **Contract** stehen.
2. Im Tab **Transactions** der **Deployer-Adresse** stehen 23 erfolgreiche Transaktionen, ohne rotes „Fail“
   (13 Contracts und 10 Konfigurations-Transaktionen).
3. Ownership prüfen: Auf Polygonscan die Adresse von `IdFactory` öffnen → **Contract** → **Read Contract** → `owner`.
   Dort muss die Safe-Adresse stehen. Ist der Contract nicht verifiziert, gibt es den Tab „Read Contract“ nicht. Dann reicht der
   Eintrag `IdFactory.transferOwnership` unter `transactions` in `deployment.json`.

---

## Schritt 8: PR im Plattform-Repo

Wie in [DEPLOYMENT.md, Schritt 8](./DEPLOYMENT.md#schritt-8-pr-im-tokenization-platform-repo-öffnen), mit `CHAIN_ID=137`
und `KUNDE="Polygon Mainnet"`. Ins Plattform-Repo kommt der Ordner `deployments/137/` (16 Dateien).

Zusätzlich eine **Sicherungskopie** von `deployments/137/` ablegen, z. B. im internen Drive. Nur mit diesem Ordner
kann das Skript später auf Polygon noch etwas nachziehen.

---

## Danach: Was der Safe jetzt besitzt

Nach dem Deployment gehören dem Safe (`TREX_OWNER`):

| Contract | Wofür der Safe gebraucht wird |
| --- | --- |
| `TREXGateway` | Weitere Backend-Deployer freischalten (`addDeployer`), Gateway öffentlich/privat schalten, Gebühren |
| `TREXImplementationAuthority` | Neue T-REX-Versionen registrieren (Upgrades der Token-Logik) |
| `IdFactory` | Weitere Token-Factories autorisieren |
| `IdentityImplementationAuthority` | Upgrade der ONCHAINID-Logik |

Die `TREXFactory` gehört dem Gateway. Neue Token-Suiten deployt euer Backend über `TREXGateway.deployTREXSuite`.
