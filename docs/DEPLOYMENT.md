# T-REX-Infrastruktur auf einer neuen Chain deployen

Diese Anleitung beschreibt, wie du für einen Kunden die komplette T-REX-Infrastruktur (Factory, Gateway, ONCHAINID usw.)
auf einer neuen EVM-Chain deployst und die Ergebnisse als PR ins Tokenization-Platform-Repo bringst.

Das Skript dazu ist `scripts/deploy-infra.ts`. Es kann nach einem Abbruch jederzeit **mit demselben Befehl einfach neu gestartet werden**:
Es macht dort weiter, wo es aufgehört hat, und sendet nichts doppelt.

---

## Übersicht

| Schritt | Was | Dauer |
| --- | --- | --- |
| 0 | Einmalig: Rechner vorbereiten | 5 Min (nur beim ersten Mal) |
| 1 | Daten vom Kunden / zur Chain sammeln | 5 Min |
| 2 | Deployer-Wallet aufladen | abhängig vom Kunden |
| 3 | Probelauf lokal | 1 Min |
| 4 | Private Key hinterlegen | 1 Min |
| 5 | Deployment starten | 1–5 Min |
| 6 | Private Key wieder löschen | 10 Sek |
| 7 | Ergebnis prüfen | 2 Min |
| 8 | PR im Tokenization-Platform-Repo öffnen | 2 Min |

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

`npx hardhat compile` lädt beim ersten Mal den Solidity-Compiler 0.8.17 herunter und muss mit
`Compiled ... Solidity files successfully` enden.

> Bei jedem späteren Deployment reicht im Ordner `ERC-3643`:
> ```bash
> git pull
> npm ci
> npx hardhat compile
> ```

---

## Schritt 1: Daten sammeln

Fülle diese Tabelle aus, **bevor** du irgendetwas startest:

| Variable | Was ist das? | Woher? | Beispiel |
| --- | --- | --- | --- |
| `RPC_URL` | RPC-Endpunkt der Chain | Kunde / Chain-Doku / RPC-Anbieter | `https://rpc.example-chain.io` |
| `EXPECTED_CHAIN_ID` | Chain-ID als Zahl | Kunde / [chainlist.org](https://chainlist.org) | `12345` |
| `GATEWAY_DEPLOYERS` | Wallet(s) unseres Plattform-Backends, die später Tokens deployen dürfen (kommagetrennt) | Backend-Team | `0xAbC...123` |
| `TREX_OWNER` | Endgültiger Owner der Infrastruktur, idealerweise ein Multisig (Safe) | wir / Kunde | `0xDeF...456` |

**Chain-ID gegenprüfen.** Dieser Befehl fragt die Chain direkt. Die Antwort ist hexadezimal:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  https://rpc.example-chain.io
# {"jsonrpc":"2.0","id":1,"result":"0x3039"}   -> 0x3039 = 12345
```

Umrechnen geht z. B. mit `node -p "0x3039"`.

> ⚠️ **`TREX_OWNER` dreimal prüfen!**
> Die Ownership-Übertragung ist endgültig. Bei einem Tippfehler oder einer Adresse, die du auf dieser Chain nicht kontrollierst,
> ist die Infrastruktur **für immer** verloren. Ein Safe-Multisig hat auf jeder Chain eine eigene Adresse und muss
> **auf genau dieser Chain** existieren. Wenn du unsicher bist, lass `TREX_OWNER` weg. Dann bleibt der Deployer Owner,
> und du überträgst die Ownership später, indem du das Skript mit gesetztem `TREX_OWNER` noch einmal ausführst.

---

## Schritt 2: Deployer-Wallet vorbereiten und aufladen

1. **Lege für jeden Kunden bzw. jede Chain eine neue Wallet an** (z. B. in MetaMask oder Rabby: „Konto hinzufügen“).
   Verwende keine Wallet, die sonst Geld hält.
2. Ein komplettes Deployment braucht etwa **29 Mio. Gas**. Das Skript startet nur, wenn Guthaben für **35 Mio. Gas** vorhanden ist.
   Den aktuellen Gaspreis fragst du so ab:

   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' \
     https://rpc.example-chain.io
   # {"result":"0x3b9aca00"}  -> node -p "0x3b9aca00"  -> 1000000000 wei = 1 gwei
   ```

   **Benötigtes Guthaben = 35.000.000 × Gaspreis**, im Beispiel 35.000.000 × 1 gwei = **0,035 Native-Token**.
   Schick zur Sicherheit etwa doppelt so viel auf die Deployer-Wallet.

---

## Schritt 3: Probelauf lokal (ohne echte Chain, kostenlos)

```bash
npx hardhat run scripts/deploy-infra.ts
```

Am Ende muss `TREXGateway (entry point for token suite deployments): 0x...` stehen.
Wenn das hier nicht funktioniert, brauchst du Schritt 5 gar nicht erst zu versuchen.

Den lokalen Ausgabe-Ordner kannst du danach löschen:

```bash
rm -rf deployments/31337
```

---

## Schritt 4: Private Key hinterlegen

```bash
npx hardhat vars set DEPLOYER_PRIVATE_KEY
```

Du wirst nach `Enter value:` gefragt. Füge den Private Key der Deployer-Wallet ein (mit oder ohne `0x`) und drück Enter.
Die Eingabe ist unsichtbar. Das ist Absicht.

> ❌ **Niemals** den Key direkt in den Befehl schreiben (`DEPLOYER_PRIVATE_KEY=0x... npm run ...`).
> Sonst steht er für immer in deiner Shell-History.

---

## Schritt 5: Deployment starten

Ersetze die Beispielwerte durch deine Werte aus Schritt 1 und führe **einen** Befehl aus:

```bash
RPC_URL=https://rpc.example-chain.io \
EXPECTED_CHAIN_ID=12345 \
GATEWAY_DEPLOYERS=0xBackendWallet \
TREX_OWNER=0xMultisigAdresse \
npm run deploy:infra
```

**Optionale Zusatz-Variablen** (normalerweise weglassen):

| Variable | Wirkung | Standard |
| --- | --- | --- |
| `CONFIRMATIONS` | Anzahl Block-Bestätigungen pro Transaktion (z. B. `3` bei unsicheren Chains) | `1` |
| `GATEWAY_PUBLIC_DEPLOYMENT` | `true` = jeder darf über das Gateway eigene Tokens deployen | `false` |
| `TREX_VERSION` | Versionsnummer, die registriert wird | Version aus `package.json` |

**So sieht ein erfolgreicher Lauf aus** (Adressen gekürzt):

```
Deploying T-REX 4.1.3 infrastructure on "target" (chain 12345)
Deployer: 0x... (balance 0.07)

1) Implementations
  + Token deployed at 0x...
  ...
7) Access control
  + TREXGateway.batchAddDeployer (tx 0x...)
  + TREXImplementationAuthority.transferOwnership (tx 0x...)
  ...

Deployment record and ABIs: .../deployments/12345
TREXGateway (entry point for token suite deployments): 0x...
```

- `+` bedeutet: gerade neu ausgeführt.
- `=` bedeutet: war schon erledigt und wurde übersprungen.

### Wenn etwas schiefgeht

**Grundregel: Fehler beheben und genau denselben Befehl noch einmal ausführen.** Bereits Erledigtes wird übersprungen.

| Fehlermeldung | Bedeutung | Lösung |
| --- | --- | --- |
| `HH100: Network target doesn't exist` | `RPC_URL` fehlt oder ist leer | `RPC_URL=...` im Befehl setzen |
| `EXPECTED_CHAIN_ID is required ...` | Chain-ID fehlt | `EXPECTED_CHAIN_ID=...` setzen |
| `RPC reports chain X, EXPECTED_CHAIN_ID is Y` | Die RPC-URL gehört zu einer anderen Chain | RPC-URL bzw. Chain-ID prüfen (Schritt 1) |
| `DEPLOYER_PRIVATE_KEY is not set` | Key nicht hinterlegt | Schritt 4 |
| `Deployer balance ... is below the estimated ...` | Zu wenig Guthaben | Wallet aufladen (Schritt 2), Befehl wiederholen |
| `Invalid CONFIRMATIONS` / `Invalid GATEWAY_PUBLIC_DEPLOYMENT` | Tippfehler in einer Variable | Wert korrigieren (`true`/`false`, Zahl ≥ 1) |
| `... was deployed by 0xA, resume it with that key` | Du hast einen anderen Key hinterlegt als beim ersten Versuch | Den ursprünglichen Key wieder hinterlegen (Schritt 4) |
| `... was deployed from different bytecode than the current artifacts` | Zwischen zwei Versuchen wurde der Code geändert (anderer Branch, `git pull`) | Zurück auf den Stand des ersten Versuchs wechseln, **oder** `deployments/<chainId>` wegverschieben und komplett neu deployen |
| `... is stale: no code for ...` | Die Chain wurde zurückgesetzt (typisch für Testnetze) | `deployments/<chainId>` wegverschieben, neu deployen |
| `... is owned by 0x..., not by the deployer` | Die Ownership liegt schon beim `TREX_OWNER` und der Deployer darf nichts mehr ändern | Die Änderung (z. B. einen neuen Gateway-Deployer) direkt über den Multisig ausführen |
| Timeout / `network error` / Abbruch mit Strg+C | RPC war kurz weg | Befehl einfach wiederholen |

> Lösche den Ordner `deployments/<chainId>` **nie**, solange das Deployment nicht fertig ist.
> Nur mit ihm kann das Skript fortsetzen.

---

## Schritt 6: Private Key wieder löschen

Sobald das Deployment durch ist:

```bash
npx hardhat vars delete DEPLOYER_PRIVATE_KEY
npx hardhat vars list   # darf DEPLOYER_PRIVATE_KEY nicht mehr anzeigen
```

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
   jeweils mit `address` und `blockNumber`.
2. Die `TREXGateway`-Adresse im Block-Explorer der Chain öffnen: Dort muss ein Contract liegen.
3. Wenn `TREX_OWNER` gesetzt war: In `deployment.json` stehen unter `transactions` neben `TREXFactory.transferOwnership` vier weitere
   `...transferOwnership`-Einträge: `TREXImplementationAuthority`, `IdentityImplementationAuthority`, `IdFactory` und `TREXGateway`.

**Wichtige Adressen für die Plattform:**

| Contract | Wofür |
| --- | --- |
| `factories.TREXGateway` | Hierüber deployt das Backend neue Token-Suiten (`deployTREXSuite`) |
| `factories.TREXFactory` | Event `TREXSuiteDeployed`: ab `blockNumber` indexieren |
| `factories.IdFactory` | Erstellt ONCHAINIDs für Investoren |
| `authorities.TREXImplementationAuthority` | Versionsverwaltung und Upgrades der Token-Logik |

---

## Schritt 8: PR im Tokenization-Platform-Repo öffnen

```bash
# 1. In das Plattform-Repo wechseln und aktuellen Stand holen
cd ../<tokenization-platform-repo>
git checkout main && git pull

# 2. Neuen Branch anlegen
git checkout -b chore/trex-infra-chain-12345

# 3. Ordner hineinkopieren (Zielpfad an die Struktur des Plattform-Repos anpassen)
mkdir -p <pfad-für-contracts>/12345
cp -r ../ERC-3643/deployments/12345/. <pfad-für-contracts>/12345/

# 4. Committen und pushen
git add <pfad-für-contracts>/12345
git commit -m "Add T-REX infrastructure for chain 12345 (<Kundenname>)"
git push -u origin chore/trex-infra-chain-12345
```

Danach öffnest du den PR auf GitHub, oder mit der GitHub CLI:

```bash
gh pr create --fill
```

Schreib in die PR-Beschreibung am besten: Kunde, Chain-Name, Chain-ID, `TREXGateway`-Adresse, `TREX_OWNER`.

> Leg zusätzlich eine Sicherungskopie von `deployments/<chainId>` ab, z. B. im internen Drive.
> Du brauchst sie, falls du auf dieser Chain später noch etwas nachziehen willst.

---

## Später: Änderungen nach dem Deployment

| Ich will ... | So geht's |
| --- | --- |
| ... die Ownership an den Multisig übertragen (war beim ersten Lauf nicht gesetzt) | Schritt 4 und 5 wiederholen, diesmal mit `TREX_OWNER=...` |
| ... einen weiteren Backend-Deployer freischalten, solange der Deployer noch Owner ist | Schritt 4 und 5 wiederholen, `GATEWAY_DEPLOYERS` um die neue Adresse ergänzen |
| ... einen weiteren Backend-Deployer freischalten, wenn schon der Multisig Owner ist | Im Multisig `TREXGateway.addDeployer(<adresse>)` ausführen |
| ... das Gateway öffentlich machen oder wieder schließen | Deployer ist Owner: Skript mit `GATEWAY_PUBLIC_DEPLOYMENT=true` bzw. `false` erneut ausführen. Multisig ist Owner: `TREXGateway.setPublicDeploymentStatus(true/false)` ausführen |

**Bekannte Einschränkung von T-REX:** Die `TREXFactory` überträgt die Ownership des *IdentityRegistryStorage* einer neuen
Token-Suite nicht an den Token-Owner. Soll ein Token-Owner später `changeImplementationAuthority` nutzen, muss der Owner
des Gateways die Ownership zuerst zurückholen: `transferFactoryOwnership` → `recoverContractOwnership` → Factory wieder an das Gateway übertragen.
