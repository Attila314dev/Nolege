# Nolege 3.0 — ellenőrzés

2026. október 28., Node.js 24.22.1.

- `npm test`: **69 sikeres teszt, 0 hiba**.
- `npm audit --omit=dev`: 0 ismert sérülékenység az ellenőrzéskor.
- `git diff --check`: sikeres.
- Az AI-tesztek és az admin böngészőpróbája szimulált szolgáltatót használnak; nem fogyasztanak éles API-kvótát.

## Adatok és szerver

940 kérdés, ebből 800 új, ChatGPT-forrású, ellenőrzendő elem 16 × 50 elosztásban; 140 eredeti kérdés jóváhagyott. A teszt ellenőrzi a kérdésszövegek egyediségét, a különböző válaszokat, magyarázatot, forrást, készítőt, állapotot és a numerikus kérdések egy részének számítását. Ez nem teljes körű tényellenőrzés; az új tartalom jóváhagyásra vár.

Adminellenőrzések: be nem lépett hozzáférés tiltása; tulajdonosi cookie, CSRF, Origin, módosított cookie elutasítása; belépési próbálkozások korlátozása; külön asszisztensi token; eredeti forrás és készítő megőrzése; verzióütközés; duplikációk kihagyása; jóváhagyott bank frissítése és futó meccs változatlansága; mentés/visszaállítás és sérült ellenőrzőösszeg elutasítása; napló megőrzése.

Tárolóellenőrzések: fájlos mentés visszaolvasása új alkalmazáspéldányban; külső módosítás védelme; GitHub SHA-alapú írás; sikertelen távoli olvasás utáni írástilalom; írási token nélküli olvasható üzem; 1 MB fölötti GitHub-fájl pontos blobjának olvasása; újratöltés és szerkesztés sorosítása.

API-ellenőrzések: állapotfrissítés nem végez modellhívást; explicit kapcsolatteszt kérés- és tokenszámlálása; napi és háttérszolgáltatói 429 különbsége; titkok kitakarása; hibás JSON, hiányos csomag, duplikált válasz, hitelesítési hiba, időtúllépés, tartalék szolgáltató. A korábbi játékmenet-, fókusz-, pontozás-, meghívó-, visszacsatlakozás- és készlettesztek is sikeresek.

## Böngésző

A `tools/admin_browser_smoke.mjs` és a `tools/browser_smoke.mjs` valódi Chromiumban futott:

| Méret | Admin | Háromkérdéses játék |
| --- | --- | --- |
| 375 × 667 | sikeres | sikeres |
| 390 × 844 | sikeres | sikeres |
| 412 × 915 | sikeres | sikeres |
| 768 × 1024 | sikeres | sikeres |
| 844 × 390 | sikeres | sikeres |
| 1365 × 900 | sikeres | sikeres |

Az adminpróba lefedi a belépést, kérdéslista megnyitását, forrásadatokat, szerkesztőablakot, API-panelt, mentési panelt, naplót és kijelentkezést; nincs vízszintes túlcsordulás vagy böngészős futási hiba. Külön tényleges felületműveletekkel ellenőrizve: API-állapotfrissítés, kapcsolatteszt, szerkeszthető AI-előnézet és annak review importja; kézi kérdés létrehozása és módosítása; többes jóváhagyás; teljes mentés letöltése és visszaállítása; ismétlődő import kihagyása. A tesztek csak elkülönített memóriabeli bankot írnak.

A játékpróba ellenőrzi a válaszokat, eredményszünetek fókusznézetét, chat tiltását és meccs utáni elérését, mobilos túlcsordulást és legalább 44 px-es válaszgombokat. Az első nézetben frissítés után is folytatódik a meccs. A böngészőteszt hosszabb kérdésidőt és 1,5 másodperces eredményszünetet használ, hogy a képernyőmentés ne léptesse át észrevétlenül a rövid tesztablakot.

Újrafuttatás:

```bash
npm ci
npx playwright install chromium
npm test
npm run test:browser
npm run test:admin-browser
```

Meglévő böngészőhöz `CHROMIUM_EXECUTABLE` adható meg. A környezetben a Playwright CDN-letöltés hibája miatt npm-ről elérhető Chromium binárissal történt az ellenőrzés. A képernyőméret-emuláció nem fizikai Android/iOS/Safari-próba.

Képek: `docs/nolege-admin-mobile.png`, `docs/nolege-admin-desktop.png`, `docs/nolege-v2.1-mobile-focus.png`.

## Éles kiadás

Az első 3.0 kiadás Render-deployja `dep-dbh1gg8m7kps73f14d3g`, forrása `09a0fd3c`; állapota live. Az éles HTTP-próba ellenőrizte a 3.0.0 verziót, a 940 kérdést, a 800 ChatGPT-forrást, a tulajdonosi Secure/HttpOnly belépést és a külön asszisztensi hozzáférést. Belépés nélkül az admin adatai 401-et adnak, CSRF nélkül a módosítás 403-at. Az export 800 új kérdést, a teljes mentés 940 elemet és érvényes ellenőrzőösszeget adott.

Az API passzív frissítésekor a szolgáltató **4/50 felhasznált, 46 megmaradt** ingyenes napi kérést jelzett. Az alkalmazás modellhívásszámlálója nem nőtt. Új éles inferencia nem indult; az API-kapcsolatteszt sikerét így nem állítjuk igazoltnak.

Az éles HTTP/WebSocket-próba két játékossal három kérdést játszott végig, 551–398 eredménnyel. A néző az aktuális kérdést kapta, a meccs alatti chat 409 game_running választ adott. A készlet Redisből működött, tárolási hiba nélkül; a próbaszoba törölve.

A hitelesítés nélküli GitHub REST-olvasás az első deployban tartalék olvasásra esett vissza. A javítás nyilvános repónál közvetlenül a GitHub nyers adatfájlját olvassa, REST-kvóta használata nélkül. Token mellett továbbra is a Contents API SHA-ellenőrzésével ír.

A tartós szerkesztéshez az alkalmazás saját, Nolege repóra korlátozott `GITHUB_BANK_TOKEN` jogosultsága szükséges; ennek hiányában az admin biztonságosan olvasható módban működik. A ChatGPT GitHub-kapcsolata ezt a futó alkalmazásnak nem adja át.

A javított kiadás deployja **`dep-dbh1k6e1egvs73ed3meg`**, forrása **`d7b5a549`**, állapota **live**. Az ismételt éles adminpróba sikeres: a bank közvetlenül GitHubról olvasható (`remote: true`, tárolási hiba nélkül), továbbra is 940 kérdéssel. Tulajdonosi és asszisztensi belépés, védett végpontok, szűrt export, ellenőrzőösszeges mentés és inferenciamentes állapotfrissítés rendben. Token nélkül az adminírás 503 storage_not_configured választ ad, nem jelez elmentetlen módosítást sikeresnek. Éles adminírás és annak GitHub-mentése a külön GITHUB_BANK_TOKEN beállítása után ellenőrizhető.
