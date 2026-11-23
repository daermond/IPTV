# IPTV

Magyar IPTV-listák szerkesztése és frissítése GitHubon. A [webszerkesztő](https://daermond.github.io/IPTV/) projektjei a `projects/` mappában vannak. Az alapértelmezett lista az [Otthon M3U](https://daermond.github.io/IPTV/playlists/otthon.m3u).

1. Nyisd meg a szerkesztőt, válassz projektet, vagy hozz létre újat.
2. A csatornaszámot és a csoportot közvetlenül a sorban módosíthatod. Az **EPG** oszlopban a **Párosítás** gomb a sor alatt nyitja meg a hozzárendelést. A csatorna nevére kattintva a neve, logója és elsődleges streamje is szerkeszthető. Az **Aktív** jelölővel kapcsolhatod ki. Kézi sorrendben húzd a sort a fogantyúval, vagy használd a fel és le nyilat.
3. **Mentéskor** adj meg egy [fine-grained GitHub-tokent](https://github.com/settings/personal-access-tokens/new), amely csak erre a repóra kap **Contents: Read and write** jogosultságot. A token az oldal memóriájában marad. A mentés azonnal új futást indít, a kész M3U a sikeres közzététel után frissül.
4. Add meg a kész M3U-címet a lejátszóban. Ha a lejátszó nem olvassa az EPG-címet a fejlécből, add hozzá külön a [magyar EPGShare URL-jét](https://epgshare01.online/epgshare01/epg_ripper_HU1.xml.gz) a lejátszó EPG-beállításaiban.

A projektfájlok és az elkészült listák nyilvánosak. Forrásként HTTPS-címeket és nyilvánosan megosztható adatokat használj. A generátor megtartja a streambejegyzések ismert lejátszási beállításait. A csatornaszámok, az M3U-ba írt EPG-címek és a több EPG-forrás kezelése lejátszófüggő. A „Minden stream” export külön sorokat ad, nem automatikus streamváltást.

## Források és frissítés

- M3U: [iptv-org magyar lista](https://github.com/iptv-org/iptv/blob/master/streams/hu.m3u). Az új csatorna bekapcsolva, eredeti adatokkal és az `Unassigned` csoportban jelenik meg. A forrásból eltűnt csatorna kimarad az exportból, beállításai megmaradnak.
- Logók: a forrás képét, majd az [iptv-org adatbázisát](https://github.com/iptv-org/api#logos) használjuk. Az egyéni HTTPS kép-URL felülírja ezeket.
- EPG: a lejátszó az eredeti szolgáltatótól tölti le a műsort. A generátor csak a forrás URL-jét és a kiválasztott XMLTV-azonosítót írja az M3U-ba. Az **EPG-javaslatok** gombbal egyszerre átnézheted és alkalmazhatod az egyértelmű egyezéseket. A szerkesztő csatornaindexe csak neveket és azonosítókat tartalmaz. Új EPG-forrás első mentésekor készül, később a [Publish IPTV playlists](https://github.com/daermond/IPTV/actions/workflows/publish.yml) futtatásakor a **Refresh the EPG channel index** opcióval frissíthető.
- További M3U-forrásokat a `sources.json` fájlban lehet felvenni, majd a projektben kiválasztani. Azonos teljes `tvg-id` esetén a streamek egy csatornához kerülnek. A feedváltozatok külön maradnak. A különböző azonosítók kézi összekapcsolásához a projektfájl opcionális `aliases` mezője használható, például `"aliases": { "id:AlternateATV.hu": "id:ATV.hu@SD" }`.
- A [változásnapló](https://github.com/daermond/IPTV/blob/main/channel-changes.log) csak a forrásonként hozzáadott és eltávolított csatornákat rögzíti. Az első sikeres beolvasás a kiinduló állapot. Üres vagy hibás forrás esetén az előző kiadás marad elérhető.
- A publikálás projektmentéskor, kézi indítással és naponta kétszer fut. A GitHub a nyilvános repók ütemezését 60 nap aktivitáshiány után letilthatja. Ilyenkor az Actions felületén kapcsolható vissza.

## Helyi fejlesztés

Node.js 24 és Python 3 szükséges. Nincsenek telepítendő csomagok. Windows alatt a `python`, más rendszereken a `python3` kerül meghívásra. Az `IPTV_PYTHON` környezeti változóval másik futtatható állomány választható.

```sh
npm run check
npm run build
npm run dev
```

A helyi felület a `http://127.0.0.1:8091` címen érhető el. A helyi generálás a `dist/` mappába ír. A GitHub-hozzáférés a helyi szerkesztőből is a távoli projektfájlokra vonatkozik. Az első publikálás előtt a repó Pages beállításában a **GitHub Actions** forrást kell kiválasztani.
