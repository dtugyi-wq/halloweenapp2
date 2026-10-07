# Halloween Packet Tracer verseny
```
npm install
# PowerShell:
$env:TEACHER_USER='tanar'; $env:TEACHER_PASS='ErosJelszo'; $env:DB_HOST='192.168.1.50'; $env:DB_USER='netlab'; $env:DB_PASSWORD='...'; $env:DB_NAME='netlab'; npm.cmd start   # http://localhost:3000
```

## Adatbázis: MariaDB (Synology NAS)
Az adatbázis motorja a Synology Package Centerből telepített **MariaDB 10** (natív DSM csomag, nem Docker), a kapcsolatot a `mysql2` csomag kezeli.

**1. Adatbázis és felhasználó létrehozása** (phpMyAdmin-ban, vagy a NAS-on `mysql -u root -p` paranccsal):
```sql
CREATE DATABASE netlab CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'netlab'@'%' IDENTIFIED BY 'ErosJelszoAdatbazishoz';
GRANT ALL PRIVILEGES ON netlab.* TO 'netlab'@'%';
FLUSH PRIVILEGES;
```
A `'netlab'@'%'` azt jelenti, hogy bármely gépről csatlakozhat ezzel a felhasználóval - ha a szerver konténer egy másik gépen/konténerben fut, mint maga a MariaDB, ez szükséges (`'netlab'@'localhost'` csak akkor lenne elég, ha ugyanazon a gépen futna mindkettő).

A táblákat (`users`, `tasks`, `student_groups`, stb.) **nem kell kézzel létrehozni** - a szerver az első indításkor automatikusan létrehozza őket (`initSchema()` a `server.js`-ben), és betölti a `content.json` kezdő feladatait.

**2. MariaDB elérhetővé tétele a konténer/kliens felől:**
- A Synology DSM-ben a MariaDB alapból csak `localhost`-ra figyel - a Package Center → MariaDB 10 → Beállítások alatt engedélyezd a hálózati hozzáférést, ha a kapcsolat kívülről (más gépről/konténerből) jön.
- Nyisd meg a 3306-os portot a NAS tűzfalán (Vezérlőpult → Biztonság → Tűzfal) a helyi hálózat felé.
- `DB_HOST` értéke a NAS **LAN IP-je** legyen (pl. `192.168.1.50`), ne `localhost`, ha a Node-szerver más gépen vagy Docker-konténerben fut, mint a MariaDB.

**3. Kapcsolat tesztelése indítás előtt:**
```
node test-db-connection.js
```
Ez megpróbál csatlakozni a `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` környezeti változókkal, kiírja a szerver verzióját, a karakterkészletet, és egy írás/olvasás próbát is végez - mielőtt a teljes szervert elindítanád.

**Környezeti változók:**
| Változó | Alapérték | Leírás |
|---|---|---|
| `DB_HOST` | `localhost` | A MariaDB szerver címe (NAS LAN IP-je) |
| `DB_PORT` | `3306` | A MariaDB portja |
| `DB_USER` | `netlab` | Adatbázis-felhasználó |
| `DB_PASSWORD` | *(üres)* | Adatbázis-felhasználó jelszava |
| `DB_NAME` | `netlab` | Adatbázis neve |

A `.pkt` fájlok, screenshotok és a topológia-kép is az adatbázisban (LONGBLOB oszlopokban) vannak, nem külön fájlrendszeren - emiatt a Docker `./data:/data` kötet már nem szükséges.
## Csak image a szerveren
A GitHub Actions (`.github/workflows/docker.yml`) minden `main` push után image-et épít a GHCR-be.
A szerveren csak a `docker-compose.server.yml` (docker-compose.yml néven) és a `.env` kell.
```
docker login ghcr.io -u FELHASZNALO     # jelszó: PAT (read:packages)
docker compose pull && docker compose up -d
```

## Git + Docker
```
git clone <REPO_URL> halloween-app && cd halloween-app
cp .env.example .env            # írd át a TEACHER_PASS értékét
docker compose up -d --build
# frissítés:  git pull && docker compose up -d --build
```
A `.env` és a `data/` mappa nincs a repóban (.gitignore).

## Docker
```
docker compose up -d --build     # http://SZERVER_IP:3000
docker compose logs -f           # a tanári jelszó itt is látszik, ha nem adtad meg
```
- Az adatbázis a Synology NAS-on futó MariaDB-ben van (lásd fentebb) - mentéshez a NAS saját adatbázis-mentési/replikációs eszközei (pl. Hyper Backup) valók, nem a konténer kötete.
- Frissítés: `docker compose up -d --build`.

- A scare.mp4 a `public/media/` mappába kerül.
- Az első indításkor létrejön a tanári fiók (jelszó: TEACHER_PASS, vagy a konzolra kiírt véletlen jelszó), és a szükséges táblák is automatikusan létrejönnek a megadott MariaDB adatbázisban.
- Környezeti változók: PORT, DURATION_MIN (alapból 160), MAX_MB (alapból 30), DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME (lásd fentebb a MariaDB szekciót).
- Adatbázis: MariaDB (`mysql2` csomagon keresztül), a .pkt fájlok, screenshotok és a topológia-kép is az adatbázis LONGBLOB oszlopaiban vannak.

## Tanári felület – új funkciók
- **🧩 Feladatok összeállítása**: a feladatok (cím, pontszám, lépések, opcionális alteszt-lista, megjegyzés) már nem a `content.json`-ból fixen jönnek, hanem adatbázisból, és a tanári felületen szabadon szerkeszthetők, sorrendezhetők, törölhetők, illetve új feladat is felvehető. Első indításkor a `content.json` 9 eredeti feladata kerül be alapértékként, onnantól a tanári felület az egyetlen forrás. Ajánlott a feladatokat a verseny **elindítása előtt** véglegesíteni, mert a lista módosítása futó verseny alatt összezavarhatja a már elindult diákok haladását.
- **👥 Csoportmunka**: a tanári felületen csoportok hozhatók létre, és tetszőlegesen beosztható, melyik diák melyik csoportba kerüljön (egy diák egyszerre csak egy csoportban lehet). A diákok a saját oldalukon látják, kik a csapattársaik.
- **🗺️ Topológia térkép**: a beépített, automatikusan rajzolt térkép helyett feltölthető egy saját kép (PNG/JPG/WEBP/SVG, max 8 MB), ami mindenkinél lecseréli azt. Bármikor visszaállítható az alap térképre.
