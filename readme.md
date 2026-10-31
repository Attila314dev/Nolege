# Nolege 3.1

Magyar többjátékos partikvíz, mobilos fókusznézettel és privát kérdésműhellyel. Node.js, Express és WebSocket; a teljes kérdésbank GitHubon tárolt JSON, a gyors játékbeli készlet külön Render Key Value tárolót használ.

Éles játék: <https://nolege-party-attila314dev.onrender.com/> · Admin: <https://nolege-party-attila314dev.onrender.com/admin>

## Színek, telefon és hangulat

- Zsályazöld, pasztellkék és korallpiros téma. A fejléc három színes négyzete közül a kiválasztott pipát kap; a választás az eszközön megmarad, az adminoldalon is érvényes.
- A **Telefonra teszem** gomb telepítési segítséget ad. Androidon Chrome → Telepítés / Hozzáadás a kezdőképernyőhöz; iPhone-on Safari → Megosztás → Kezdőképernyőhöz adás, szükség esetén Megnyitás webappként. Saját ikon és külön alkalmazásablak, HTTPS-en. Az élő meccshez internet kell; kapcsolat nélkül újracsatlakozási oldal jelenik meg. A service worker nem tárol API-válaszokat, adminoldalt vagy hitelesített adatokat.
- Eredeti, helyben előállított halk ambient a kérdések és eredményszünetek alatt. Az első érintés engedélyezi a hangot. Az utolsó öt másodpercben ketyegés, válaszadás után csendesedő sürgetés; a háttérzene halkul a ketyegés alatt.
- **♪ Hang:** külön zene- és effekthangerő, külön kikapcsolás; meccs közben egyérintéses némítás. A beállítások megmaradnak. Háttérbe tett lapon és megszakadt kapcsolatnál a hang leáll. Ehhez nincs hangfájl-letöltés vagy AI-kérés.
- A győztes saját képernyőjén konfetti és rövid csilingelés. Pozitív pontszámú holtversenynél minden első helyezett ünnepelhet; frissítés nem ismétli a konfettit. Csökkentett mozgásnál a csillagos győzelmi jelzés animáció nélkül jelenik meg.

## Kérdésműhely

- Belépéshez kötött `/admin`, nyilvános regisztráció nélkül. Külön tulajdonosi jelszó és asszisztensi bearer-token; a szerver csak ezek hashét tárolja.
- **940 kérdés:** 140 korábbi és **800 ChatGPT-forrású kérdés**, 16 témakörben. Az induló 800 ellenőrzendőként került be; a tulajdonos azóta jóváhagyta őket. Az aktuális állapotot mindig a tartós bank őrzi. A kezdeti cél 1000, a jelenlegi védelmi felső korlát 10 000 kérdés.
- Keresés, témakör-, nehézség-, forrás- és állapotszűrés; egyedi szerkesztés, hozzáadás, többes jóváhagyás és archiválás.
- Eredeti forrás: kézi / ChatGPT / AI-API. A korábbi 140 elem ismeretlen eredetét külön „Korábbi bank” jelöli. Az eredeti készítő és időpont szerkesztéskor megmarad, a módosító külön rögzül.
- Piszkozat, ellenőrzendő, jóváhagyott, archivált állapot. A közös bankból indított játék csak jóváhagyott kérdéseket kaphat. Egy futó meccs kérdéssora rögzített; egy adminváltozás nem írja át.
- JSON-import/export, azonos normalizált kérdésszövegek kiszűrése. Az import ellenőrzendő kérdéseket hoz létre. A tartalmilag hasonló, eltérően megírt kérdésekhez szerkesztői ellenőrzés szükséges.
- Teljes, SHA-256 ellenőrzőösszeges JSON-mentés és visszaállítás; GitHub-verzióelőzmények és korábbi bankverzió visszaállítása új commitként. A változásnapló az utolsó 1000 műveletet őrzi a bankban; a korábbi állapotok a Git-előzményekben maradnak.
- Egyszerre érkező szerkesztéseknél verzióellenőrzés véd a felülírás ellen. Ütközés után a **Bank frissítése** gomb tölti be a legutóbbi távoli állapotot.

Az új 800 kérdés külön szolgáltatói modellhívás nélkül készült. Szerkezetük és egyediségük ellenőrzött; ez nem teljes körű tényellenőrzés. Az eredeti kérdéskártyák a `tools/question-cards/` mappában vannak. A `npm run build:catalog` **újraépíti a teljes induló bankot**, ezért egy már szerkesztett éles bank mentését ne írd felül vele.

## Tartós mentés és belépés beállítása

A `bank/catalog.json` az elsődleges kérdésbank. GitHub kiszolgálja és verziózza az adatfájlt; a webalkalmazást Render futtatja. Nyilvános repónál a token nélküli böngészés közvetlenül a GitHub nyers fájlját olvassa, REST-kvóta nélkül. A repó nyilvánossága a kérdésadatokra is vonatkozik; a belépési adatok és API-kulcsok nem kerülnek bele.

Renderben a tartós íráshoz külön **`GITHUB_BANK_TOKEN`** kell. Ez független a ChatGPT GitHub-kapcsolatától. Hozz létre fine-grained GitHub-tokent, kizárólag az **Attila314dev/Nolege** repóhoz, **Contents: Read and write** jogosultsággal, és add meg közvetlenül a [Render Environment](https://dashboard.render.com/web/srv-dbgbhlec6qcc73eucbbg/env) felületen. A többi jogosultság maradjon kikapcsolva. A `GITHUB_BANK_REPO` alapértéke `Attila314dev/Nolege`.

Token nélkül a belépett admin böngészni, exportálni, mentést letölteni és API-állapotot vizsgálni tud; szerkesztést nem jelez sikeresnek. Sikertelen távoli olvasás után sem írja felül a bankot a telepített tartalékkal. Az induláshoz a telepített JSON olvasható marad.

Új belépés biztonságos előállítása:

```bash
node tools/create_admin_access.mjs
```

A parancs véletlen jelszót és külön asszisztensi tokent készít egy új, privát ideiglenes JSON-fájlba. Csak a fájl útvonalát írja ki. A benne lévő `renderEnv` mező alábbi értékeit másold a Render Environment változói közé:

| Változó | Tartalom |
| --- | --- |
| `ADMIN_OWNER_USERNAME` | tulajdonosi felhasználónév, alapból `attila` |
| `ADMIN_OWNER_PASSWORD_HASH` | scrypt jelszóhash |
| `ADMIN_ASSISTANT_TOKEN_HASH` | a véletlen asszisztensi token SHA-256 hashe |
| `ADMIN_SESSION_SECRET` | legalább 32 karakteres, véletlen aláíró titok |

A nyers jelszót és asszisztensi tokent tartsd privát helyen. Éles titkot ne commitolj. Új értékek telepítése visszavonja a régi belépést. A tulajdonosi munkamenet 12 órás, HttpOnly és SameSite=Strict cookie-t használ; HTTPS alatt Secure is. Az írást CSRF- és Origin-ellenőrzés védi, a sikertelen belépések száma korlátozott. A `render.yaml` az infrastruktúrát írja le; az admin titkai a szolgáltatás saját Environment felületén maradnak.

Az asszisztensi hozzáférés az `/api/admin/*` végpontokhoz `Authorization: Bearer <saját asszisztensi token>` fejlécet használ. Ez önmagában nem ad automatikus hozzáférést egy új ChatGPT-beszélgetésnek; a privát tokent az adott munkamenetben kell rendelkezésre bocsátani.

## API-panel és generálás

Az **Állapot frissítése** szolgáltatói modell- és fiókadatokat kérdez le, modellgenerálás nélkül. A **Kapcsolatteszt** valódi, rövid modellkérést használ. A panel mutatja a szolgáltatót, modellt, kulcsbeállítottságot, utolsó valódi sikeres hívást, a kitakart szolgáltatói hibát, valamint a kérés- és tokenhasználatot. A számlálók az alkalmazás aktuális indulása óta értendők; a szolgáltatói napi kvóta ettől független, és csak akkor jelenik meg, ha az API megadja.

A HTTP 429 különböző korlátozásokat jelenthet. A panel megkülönbözteti a szolgáltató által jelzett napi limitet, a modell háttérszolgáltatójának korlátját és az ismeretlen eredetű limitet. Nem következtet automatikusan elfogyott ingyenes keretre.

AI-hozzáféréshez `OPENROUTER_API_KEY` vagy `GROQ_API_KEY` szükséges Renderben. A kulcsot az alkalmazás nem küldi böngészőbe. A bank beállítása az ingyenes `google/gemma-4-26b-a4b-it:free` OpenRouter-modell; más `:free` modell az adminból menthető. Groq esetén a kód `openai/gpt-oss-120b` modellt használ. A szolgáltató tényleges fiókkorlátai érvényesek, a kód nem választ fizetős OpenRouter-modellt. Több szolgáltató beállításakor tartalék próbálkozás is történhet, a kérésnapló a tényleges hívásokat számlálja.

Az adminban témára és 1–30 kérdésre kérhető AI-csomag. Szerkeszthető előnézet után **ellenőrzendőként** menthető; közös játékba jóváhagyás után kerül. Az előnézet 30 percig él.

A gyors készlet célja **100 kérdés**. Először a jóváhagyott bank még fel nem használt kérdéseiből töltődik. A háttérben új AI-kérdések készítése **alapból ki van kapcsolva**. Bekapcsolva legfeljebb 20 kérdéses adagok, legfeljebb 12 háttérhívás/UTC-nap készülhet; ezek is ellenőrzésre várnak. Kvóta- vagy szolgáltatói hiba várakozást eredményez. A meglévő bankból tovább lehet játszani, a kérdések újrafelhasználását a felület jelzi.

A játékbeli egyedi téma, például „Modern popzene”, külön ideiglenes kérdéssor. A szobagazda előnézetben fogadja el, és nem tölti automatikusan a közös bankot. Hibás generálás megőrzi a korábbi csomagot, és nem helyettesíti a kért témát általános kvízzel. A szobai JSON-mentés később új API-hívás nélkül visszatölthető.

## Játék

Alapból általános kvíz, 15 kérdéssel. Új fordulónál témakör, 1–30 kérdés, nehézség és 10/15/20/30 másodperces válaszidő választható.

- Meghívólink és QR-kód; kézi szobakódhoz opcionális jelszó. A meghívó önmagában belépést ad.
- Indítás előtt minden online játékos kész jelzése szükséges.
- Helyes válaszonként 100 alappont és legfeljebb 100 gyorsasági bónusz; hibás vagy kihagyott válasz 0 pont.
- Fókusznézet a teljes meccs alatt, az eredményszünetekben is. A Kvízmester szerveroldalon is tiltott a végéig.
- Mobilos elrendezés, opcionális teljes képernyő és kijelző-ébren-tartás, ahol a böngésző engedi. Ez nem kapcsol rendszerszintű Ne zavarjanak módot.
- Újracsatlakozás megőrzött játékosazonossággal; menet közbeni nézők; meccs utáni kérdésmagyarázatok és Kvízmester.

## Futtatás és ellenőrzés

Node.js 22–24, a telepítéshez 24.22.1:

```bash
npm ci
npm start
# http://localhost:10000
npm test
npx playwright install chromium
npm run test:browser
npm run test:admin-browser
npm run test:experience-browser
```

Az opcionális `.env` sablonja az `.env.example`. A szerver induláskor beolvassa. Helyben a bank atomikusan mentett JSON (`CATALOG_FILE`), Renderben mindig GitHub-tároló. A pool helyben `data/general-pool.json`, Renderben `REDIS_URL`-hoz kapcsolt Key Value. A Free Key Value saját újraindulásakor elveszhet a készlete; a GitHub-bank ettől függetlenül megmarad.

A `render.yaml` egy Free Node.js webszolgáltatást és külön Free Key Value tárolót ír le Frankfurtban. Build: `npm ci`, start: `npm start`, health: `/healthz`, autodeploy kikapcsolva. A szerver `0.0.0.0:$PORT` címen figyel. A Free webszolgáltatás alvásból ébredése várakozással járhat; a memóriában lévő szobák és pontok újraindításkor megszűnnek. Egyetlen szerverpéldányra készült.

A tesztek szimulált AI-t használnak, **nem fogyasztanak valódi szolgáltatói kvótát**. A böngészős próbák Chromiumban mobilméretet emulálnak; fizikai Android- és iOS/Safari-próba külön szükséges. Részletes eredmények: [TESTING.md](TESTING.md).

Fő fájlok: `lib/catalog.js`, `lib/catalog-store.js`, `lib/admin-auth.js`, `lib/admin.js`, `public/admin.*`, `lib/server.js`, `lib/question-pool.js`, `bank/catalog.json`. A korábbi PostgreSQL-es `tools/import_questions.js` és `tools/schema.sql` nem része a futó alkalmazásnak.

Referenciák: [GitHub Contents API](https://docs.github.com/en/rest/repos/contents), [Render titkok](https://render.com/docs/configure-environment-variables), [Render Free](https://render.com/docs/free), [OpenRouter](https://openrouter.ai/docs/api-reference/limits).
