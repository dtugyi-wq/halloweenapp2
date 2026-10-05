# Halloween Packet Tracer verseny
```
npm install
# PowerShell:
$env:TEACHER_USER='tanar'; $env:TEACHER_PASS='ErosJelszo'; npm.cmd start   # http://localhost:3000
```
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
- Az adatbázis a `./data/halloween.db` fájlban van (kötet), mentéshez: `docker compose stop` után másold le a `data` mappát.
- Frissítés: `docker compose up -d --build`.

- A scare.mp4 a `public/media/` mappába kerül.
- Az első indításkor létrejön a tanári fiók (jelszó: TEACHER_PASS, vagy a konzolra kiírt véletlen jelszó).
- Környezeti változók: PORT, DURATION_MIN (alapból 160), MAX_MB (alapból 30), DB_FILE (alapból halloween.db).
- Adatbázis: a Node beépített SQLite-ja (node:sqlite, Node 22.5+), fájl: halloween.db, a .pkt fájlok a `files` tábla BLOB oszlopában vannak.
