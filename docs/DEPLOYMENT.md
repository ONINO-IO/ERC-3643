# T-REX-Infrastruktur auf einer neuen Chain deployen

Diese Anleitung beschreibt, wie du für einen Kunden die komplette T-REX-Infrastruktur (Factory, Gateway, ONCHAINID usw.)
auf einer neuen EVM-Chain deployst und die Ergebnisse als PR ins Tokenization-Platform-Repo bringst.

> Für **Polygon Mainnet** gibt es eine eigene Anleitung mit allen Werten vorausgefüllt: [DEPLOYMENT-POLYGON.md](./DEPLOYMENT-POLYGON.md).

Das Skript dazu ist `scripts/deploy-infra.ts`. Wird es abgebrochen (Netzwerkfehler, Strg+C, zu wenig Guthaben),
startest du es einfach **mit demselben Befehl** neu. Es macht dort weiter, wo es aufgehört hat. Transaktionen, die beim Abbruch
noch unterwegs waren, wartet es ab, statt sie ein zweites Mal zu senden.

---

## Übersicht

| Schritt | Was | Dauer |
| --- | --- | --- |
| 0 | Einmalig: Rechner vorbereiten | 5 Min (nur beim ersten Mal) |
| 1 | Daten vom Kunden / zur Chain sammeln und prüfen | 5 Min |
| 2 | Deployer-Wallet anlegen und aufladen | abhängig vom Kunden |
| 3 | Probelauf lokal mit den echten Adressen | 1 Min |
| 4 | Private Key hinterlegen | 1 Min |
| 5 | Deployment starten | 1–5 Min |
| 6 | Private Key wieder löschen | 10 Sek |
| 7 | Ergebnis prüfen | 2 Min |
| 8 | PR im Tokenization-Platform-Repo öffnen | 2 Min |

### Allgemeine Hinweise zu den Ausgaben

- Warnungen wie `DeprecationWarning: The punycode module is deprecated`, `npm WARN deprecated ...` oder
  `... vulnerabilities` kannst du **ignorieren**.
- Wenn ein Befehl fehlschlägt, erscheint oft ein langer Block mit `at ...`-Zeilen. Wichtig ist nur die Zeile, die mit
  **`Error`** beginnt. Diese Meldung schlägst du in der Fehlertabelle bei Schritt 5 nach.

---

## Schritt 0: Einmalig den Rechner vorbereiten

Du brauchst **Node.js 18 oder neuer** (getestet mit Node 22) und **git**.

```bash
node --version   # muss v18.x oder höher anzeigen
git --version
```

Repository holen und Abhängigkeiten installieren:

```bash
git clone https://github.com/ONINO-IO/ERC-3643.git
cd ERC-3643
git checkout claude/trex-deployment-script-review-j5bdig   # bzw. main, sobald gemerged
npm ci
npx hardhat compile
```

`npx hardhat compile` lädt beim ersten Mal den Solidity-Compiler herunter. Es muss mit
`Compiled ... Solidity files successfully` oder `Nothing to compile` enden.

> Bei jedem **neuen** Deployment führst du vorher im Ordner `ERC-3643` aus:
> ```bash
> git pull
> npm ci
> npx hardhat compile
> ```
> ⚠️ **Nicht** zwischen einem abgebrochenen Deployment und seiner Fortsetzung. Dann könnte sich der Code geändert haben,
> und das Skript verweigert das Fortsetzen (siehe Fehlertabelle: „different bytecode“).

---

## Schritt 1: Daten sammeln und prüfen

Fülle diese Tabelle aus, **bevor** du irgendetwas startest:

| Variable | Was ist das? | Woher? | Beispiel |
| --- | --- | --- | --- |
| `RPC_URL` | RPC-Endpunkt der Chain | Kunde / Chain-Doku / RPC-Anbieter | `https://rpc.example-chain.io` |
| `EXPECTED_CHAIN_ID` | Chain-ID als Zahl | Kunde / [chainlist.org](https://chainlist.org) | `12345` |
| `GATEWAY_DEPLOYERS` | Wallet(s) unseres Plattform-Backends, die später Tokens deployen dürfen (kommagetrennt) | Backend-Team | `0xAbC...123` |
| `TREX_OWNER` | Endgültiger Owner der Infrastruktur, idealerweise ein Multisig (Safe) | wir / Kunde | `0xDeF...456` |

Für die folgenden Prüfbefehle setzt du die RPC-URL einmal im Terminal:

```bash
export RPC_URL=https://rpc.example-chain.io
```

> Enthält die RPC-URL einen **API-Key**, gib sie stattdessen verdeckt ein. Sonst landet der Key in der Shell-History:
> ```bash
> read -rsp 'RPC_URL: ' RPC_URL && export RPC_URL && echo
> ```

**1a) Chain-ID gegenprüfen.** Die Antwort ist hexadezimal:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL"
# {"jsonrpc":"2.0","id":1,"result":"0x3039"}
node -p "0x3039"     # den Hex-Wert aus der Antwort einsetzen -> 12345
```

**1b) Prüfen, ob der Multisig (`TREX_OWNER`) auf dieser Chain existiert:**

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xDeF...456","latest"]}' "$RPC_URL"
```

- Ist `"result"` **länger als `"0x"`**, liegt dort ein Contract (z. B. ein Safe). ✅
- Ist `"result":"0x"`, liegt dort **kein** Contract. Ein Safe wurde auf dieser Chain also noch nicht angelegt, oder die
  Adresse ist falsch. ❌ So nicht weitermachen.

> ⚠️ **`TREX_OWNER` dreimal prüfen!**
> Die Ownership-Übertragung ist endgültig. Bei einem Tippfehler oder einer Adresse, die du auf dieser Chain nicht kontrollierst,
> ist die Infrastruktur **für immer** verloren. Ein Safe-Multisig hat auf jeder Chain eine eigene Adresse und muss
> **auf genau dieser Chain** existieren. Wenn du unsicher bist, lass `TREX_OWNER` weg. Dann bleibt der Deployer Owner,
> und du überträgst die Ownership später, indem du das Skript mit gesetztem `TREX_OWNER` noch einmal ausführst.

---

## Schritt 2: Deployer-Wallet anlegen und aufladen

1. **Lege für jeden Kunden bzw. jede Chain eine neue Wallet an.** Verwende keine Wallet, die sonst Geld hält.
   In MetaMask: Kontoauswahl oben → **Konto hinzufügen** → **Neues Konto**.
2. **Private Key exportieren** (brauchst du in Schritt 4). In MetaMask: **⋮** beim Konto → **Kontodetails** →
   **Privaten Schlüssel anzeigen** → Passwort eingeben → kopieren. Den Key nirgends abspeichern.
3. **Benötigtes Guthaben berechnen.** Ein komplettes Deployment braucht etwa **29 Mio. Gas**. Das Skript startet nur, wenn
   Guthaben für **35 Mio. Gas** vorhanden ist. Frag den aktuellen Gaspreis ab:

   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' "$RPC_URL"
   # {"jsonrpc":"2.0","id":1,"result":"0x6fc23ac0"}
   ```

   Dann rechnest du das benötigte Guthaben direkt in Native-Token aus. Den Hex-Wert aus der Antwort einsetzen:

   ```bash
   node -p "35e6 * 0x6fc23ac0 / 1e18"
   # 0.065625   <- so viele Native-Token (ETH, POL, ...) werden mindestens benötigt
   ```

4. **Schick etwa das Doppelte** dieses Betrags auf die neue Deployer-Wallet.

---

## Schritt 3: Probelauf lokal mit den echten Adressen (kostenlos)

Der Probelauf spielt das komplette Deployment auf einer simulierten Chain auf deinem Rechner durch.
Dabei sendet er **nichts** an eine echte Chain. Setz die **gleichen Adressen** ein wie später in Schritt 5.
So fallen falsch kopierte Adressen schon hier auf.

```bash
GATEWAY_DEPLOYERS=0xAbC...123 \
TREX_OWNER=0xDeF...456 \
npx hardhat run scripts/deploy-infra.ts
```

Es muss enden mit:

```
  + TREXGateway.transferOwnership (tx 0x...)      <- nur wenn TREX_OWNER gesetzt ist
Dry run on the in-process hardhat network finished, nothing was sent to a real chain.
...
TREXGateway (entry point for token suite deployments): 0x...
```

- Kommt `Error: invalid address` oder `Error: bad address checksum`, ist eine Adresse in `GATEWAY_DEPLOYERS` oder `TREX_OWNER`
  falsch kopiert. Kopier sie neu und wiederhol Schritt 3.
- Wenn der Probelauf nicht funktioniert, brauchst du Schritt 5 gar nicht erst zu versuchen.

Das Ergebnis des Probelaufs landet in `deployments/dry-run/` und wird bei jedem Probelauf überschrieben. Du musst dort nichts tun.

---

## Schritt 4: Private Key hinterlegen

```bash
npx hardhat vars set DEPLOYER_PRIVATE_KEY
```

Du wirst nach `Enter value:` gefragt. Füge den Private Key aus Schritt 2 ein (mit oder ohne `0x`) und drück Enter.
Die Eingabe erscheint nur als Sternchen `*`.

> Funktioniert das Einfügen im Terminal nicht, kannst du den Key auch aus der Zwischenablage übergeben
> (macOS: `pbpaste | npx hardhat vars set DEPLOYER_PRIVATE_KEY`).
>
> ❌ **Niemals** den Key direkt in den Befehl schreiben (`DEPLOYER_PRIVATE_KEY=0x... npm run ...`).
> Sonst steht er für immer in deiner Shell-History.

---

## Schritt 5: Deployment starten

> ⚠️ **Ab hier wird es echt.** Nach deiner Bestätigung sendet der Befehl echte Transaktionen, die Geld kosten, und überträgt
> am Ende die Ownership. Nutz ihn **nicht**, um Variablen auszuprobieren. Dafür ist der Probelauf in Schritt 3 da.

Ersetze die Beispielwerte durch deine Werte aus Schritt 1. `RPC_URL` ist aus Schritt 1 noch gesetzt. Wenn du inzwischen ein
neues Terminal geöffnet hast, setz es erneut.

```bash
EXPECTED_CHAIN_ID=12345 \
GATEWAY_DEPLOYERS=0xAbC...123 \
TREX_OWNER=0xDeF...456 \
npm run deploy:infra
```

Das Skript prüft zuerst alles und zeigt dir dann eine Zusammenfassung:

```
About to send REAL transactions:
  Chain              12345 via rpc.example-chain.io
  Deployer           0x... (balance 0.13, ~0.065625 needed)
  TREX_OWNER         0xDeF...456
  GATEWAY_DEPLOYERS  0xAbC...123
  Public gateway     false
  Mode               fresh deployment

Type the chain id (12345) to start, anything else aborts:
```

**Lies die Zusammenfassung Zeile für Zeile.** Steht unter `TREX_OWNER` die Warnung
`WARNING: no contract at this address on this chain`, gibst du **nichts** ein, drückst Enter und prüfst Schritt 1b.
Ist alles richtig, tippst du die Chain-ID ein und drückst Enter.

**Optionale Zusatz-Variablen** (normalerweise weglassen):

| Variable | Wirkung | Standard |
| --- | --- | --- |
| `CONFIRMATIONS` | Anzahl Block-Bestätigungen pro Transaktion (z. B. `3` bei unsicheren Chains) | `1` |
| `GATEWAY_PUBLIC_DEPLOYMENT` | `true` = jeder darf über das Gateway eigene Tokens deployen | `false` |
| `TREX_VERSION` | Versionsnummer, die registriert wird | Version aus `package.json` |

**So sieht ein erfolgreicher Lauf aus** (gekürzt):

```
> @erc3643org/erc-3643@4.1.3 deploy:infra
> hardhat run --network target scripts/deploy-infra.ts

Deploying T-REX 4.1.3 infrastructure on "target" (chain 12345)
...
1) Implementations
  + Token deployed at 0x...
  ...
6) TREXGateway
  + TREXGateway deployed at 0x...
  = TREXGateway.setPublicDeploymentStatus already applied
  ...
7) Access control
  + TREXGateway.batchAddDeployer (tx 0x...)
  + TREXImplementationAuthority.transferOwnership (tx 0x...)
  ...

Deployment record and ABIs: .../deployments/12345
TREXGateway (entry point for token suite deployments): 0x...
```

Was die Zeichen am Zeilenanfang bedeuten:

| Zeichen | Bedeutung |
| --- | --- |
| `+` | gerade neu ausgeführt |
| `=` | war schon erledigt und wurde übersprungen. **Auch beim allerersten Lauf** erscheint `= TREXGateway.setPublicDeploymentStatus already applied`, das ist normal. |
| `~` | nur beim Fortsetzen: Das Skript wartet auf eine Transaktion, die beim Abbruch noch unterwegs war |

Beim Fortsetzen steht außerdem ganz oben `Resuming deployment from .../deployment.json`, und in der Zusammenfassung
`Mode resume (...)`.

### Wenn etwas schiefgeht

**Grundregel: Fehler beheben und genau denselben Befehl noch einmal ausführen.** Bereits Erledigtes wird übersprungen.

| Fehlermeldung (Zeile mit `Error`) | Bedeutung | Lösung |
| --- | --- | --- |
| `Aborted, nothing was sent` | Du hast bei der Rückfrage nicht die richtige Chain-ID eingegeben | Zusammenfassung prüfen, Befehl wiederholen |
| `HH100: Network target doesn't exist` | `RPC_URL` fehlt oder ist leer (z. B. neues Terminal) | `RPC_URL` setzen (Schritt 1) |
| `EXPECTED_CHAIN_ID is required ...` | Chain-ID fehlt | `EXPECTED_CHAIN_ID=...` setzen |
| `RPC reports chain X, EXPECTED_CHAIN_ID is Y` | Die RPC-URL gehört zu einer anderen Chain | RPC-URL bzw. Chain-ID prüfen (Schritt 1a) |
| `DEPLOYER_PRIVATE_KEY is not set` | Key nicht hinterlegt | Schritt 4 |
| `Deployer balance ... is below the estimated ...` | Zu wenig Guthaben | Wallet aufladen (Schritt 2), Befehl wiederholen |
| `invalid address` / `bad address checksum` | Adresse in `GATEWAY_DEPLOYERS` oder `TREX_OWNER` falsch kopiert | Adresse neu kopieren |
| `Invalid CONFIRMATIONS` / `Invalid GATEWAY_PUBLIC_DEPLOYMENT` | Tippfehler in einer Variable | Wert korrigieren (`true`/`false`, ganze Zahl ≥ 1) |
| `... was deployed by 0xA, resume it with that key` | Du hast einen anderen Key hinterlegt als beim ersten Versuch | Den ursprünglichen Key wieder hinterlegen (Schritt 4) |
| `... was deployed from different bytecode than the current artifacts` | Zwischen zwei Versuchen wurde der Code geändert (anderer Branch, `git pull`) | Zurück auf den Stand des ersten Versuchs wechseln, **oder** `deployments/<chainId>` wegverschieben und komplett neu deployen |
| `... is stale: no code for ...` | Die Chain wurde zurückgesetzt (typisch für Testnetze) | `deployments/<chainId>` wegverschieben, neu deployen |
| `... is owned by 0x..., not by the deployer` | Die Ownership liegt schon beim `TREX_OWNER`, der Deployer darf nichts mehr ändern | Die Änderung (z. B. einen neuen Gateway-Deployer) direkt über den Multisig ausführen |
| Timeout / `network error` / Abbruch mit Strg+C | RPC war kurz weg | Befehl einfach wiederholen |

> Lösche den Ordner `deployments/<chainId>` **nie**, solange das Deployment nicht fertig ist.
> Nur mit ihm kann das Skript fortsetzen.

---

## Schritt 6: Private Key wieder löschen

Sobald das Deployment durch ist:

```bash
npx hardhat vars delete DEPLOYER_PRIVATE_KEY
npx hardhat vars list
```

**Beide Befehle geben nichts aus.** Das ist korrekt und heißt: Es ist kein Key mehr gespeichert.
Taucht bei `vars list` noch `DEPLOYER_PRIVATE_KEY` auf, wiederhol den ersten Befehl.

Hardhat speichert den Key sonst **unverschlüsselt** in einer Datei auf deinem Rechner (`npx hardhat vars path` zeigt, wo).
Übrig gebliebenes Guthaben auf der Deployer-Wallet kannst du danach zurücküberweisen.

---

## Schritt 7: Ergebnis prüfen

Der Ordner `deployments/<chainId>/` enthält alles, was die Plattform braucht:

```
deployments/12345/
├── deployment.json      # Adressen, Deploy-Blocks und Transaktionen aller Contracts
└── abis/                # ABIs aller Contracts (15 Dateien)
    ├── TREXGateway.json
    ├── TREXFactory.json
    ├── Token.json
    ├── IdFactory.json
    └── ...
```

Kurz-Check:

1. In `deployment.json` gibt es unter `factories` die Einträge `TREXGateway`, `TREXFactory`, `IdFactory` und `IAFactory`,
   jeweils mit `address` und `blockNumber`. Unter `pending` steht `{}`.
2. Das Gateway liegt wirklich auf der Chain. Öffne die `TREXGateway`-Adresse im Block-Explorer. Gibt es keinen Explorer,
   prüfst du es per `curl` (Adresse einsetzen). `"result"` muss länger als `"0x"` sein:
   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xGATEWAY...","latest"]}' "$RPC_URL"
   ```
3. Wenn `TREX_OWNER` gesetzt war: In `deployment.json` stehen unter `transactions` neben `TREXFactory.transferOwnership` vier weitere
   `...transferOwnership`-Einträge: `TREXImplementationAuthority`, `IdentityImplementationAuthority`, `IdFactory` und `TREXGateway`.

**Wichtige Adressen für die Plattform:**

| Contract | Wofür |
| --- | --- |
| `factories.TREXGateway` | Hierüber deployt das Backend neue Token-Suiten (`deployTREXSuite`) |
| `factories.TREXFactory` | Event `TREXSuiteDeployed`: ab `blockNumber` indexieren |
| `factories.IdFactory` | Erstellt ONCHAINIDs für Investoren |
| `authorities.TREXImplementationAuthority` | Versionsverwaltung und Upgrades der Token-Logik |

> 📦 **Wohin mit `deployments/<chainId>`?**
> **Nicht** im ERC-3643-Repo committen. Der Ordner kommt in Schritt 8 ins Plattform-Repo. Leg zusätzlich eine
> Sicherungskopie ab, z. B. im internen Drive. Du brauchst den Ordner, falls du auf dieser Chain später noch etwas nachziehen willst
> (siehe „Später“).

---

## Schritt 8: PR im Tokenization-Platform-Repo öffnen

**8a) Einmal die Variablen setzen.** Die ersten beiden Zeilen passt du an. Die Pfade müssen zu deinem Rechner passen:

```bash
CHAIN_ID=12345                                              # Chain-ID aus Schritt 1
KUNDE="Kundenname"
ERC3643_DIR=~/code/ERC-3643                                 # wo das ERC-3643-Repo liegt
PLATFORM_DIR=~/code/<tokenization-platform-repo>            # wo das Plattform-Repo liegt
TARGET_DIR=<pfad-für-contracts>/$CHAIN_ID                   # Zielordner im Plattform-Repo
```

**8b) Branch anlegen, Dateien kopieren und prüfen:**

```bash
cd "$PLATFORM_DIR"
git checkout main && git pull
git checkout -b chore/trex-infra-chain-$CHAIN_ID

mkdir -p "$TARGET_DIR"
cp -r "$ERC3643_DIR/deployments/$CHAIN_ID/." "$TARGET_DIR/"
git add "$TARGET_DIR"
git status
```

`git status` muss **16 neue Dateien** unter `Changes to be committed` zeigen: `deployment.json` und 15 Dateien in `abis/`.
Sind es weniger, schließt die `.gitignore` des Plattform-Repos Dateien aus. Dann bitte melden und nicht weitermachen.

**8c) Committen, pushen, PR öffnen:**

```bash
git commit -m "Add T-REX infrastructure for chain $CHAIN_ID ($KUNDE)"
git push -u origin chore/trex-infra-chain-$CHAIN_ID
```

Den PR öffnest du auf GitHub über den Link, den `git push` ausgibt, oder mit der GitHub CLI: `gh pr create --fill`.
In die PR-Beschreibung gehören: Kunde, Chain-Name, Chain-ID, `TREXGateway`-Adresse und `TREX_OWNER`.

---

## Später: Änderungen nach dem Deployment

Für alle Änderungen per Skript brauchst du den Ordner `deployments/<chainId>` (bzw. die Sicherungskopie) wieder im
ERC-3643-Repo, denselben Code-Stand und denselben Deployer-Key (Schritt 4).

| Ich will ... | So geht's |
| --- | --- |
| ... die Ownership an den Multisig übertragen (war beim ersten Lauf nicht gesetzt) | Schritt 4 und 5 wiederholen, diesmal mit `TREX_OWNER=...` |
| ... einen weiteren Backend-Deployer freischalten, solange der Deployer noch Owner ist | Schritt 4 und 5 wiederholen, `GATEWAY_DEPLOYERS` um die neue Adresse ergänzen |
| ... einen weiteren Backend-Deployer freischalten, wenn schon der Multisig Owner ist | Im Multisig `TREXGateway.addDeployer(<adresse>)` ausführen |
| ... das Gateway öffentlich machen oder wieder schließen | Deployer ist Owner: Skript mit `GATEWAY_PUBLIC_DEPLOYMENT=true` bzw. `false` erneut ausführen. Multisig ist Owner: `TREXGateway.setPublicDeploymentStatus(true/false)` ausführen |

**Bekannte Einschränkung von T-REX:** Die `TREXFactory` überträgt die Ownership des *IdentityRegistryStorage* einer neuen
Token-Suite nicht an den Token-Owner. Soll ein Token-Owner später `changeImplementationAuthority` nutzen, muss der Owner
des Gateways die Ownership zuerst zurückholen: `transferFactoryOwnership` → `recoverContractOwnership` → Factory wieder an das Gateway übertragen.
