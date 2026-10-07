// Gyors kapcsolat-teszt a MariaDB-hez, mielőtt elindítanád a teljes szervert.
// Futtatás a NAS-on / Docker konténerben (ugyanazokkal a környezeti változókkal, mint a szervert):
//   node test-db-connection.js
// vagy Dockerből:
//   docker compose run --rm halloween node test-db-connection.js
const mysql = require('mysql2/promise');

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: +process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'netlab',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'netlab',
  charset: 'utf8mb4_unicode_ci'
};

console.log('Kapcsolódás próba ehhez:', { ...cfg, password: cfg.password ? '(megadva)' : '(ÜRES!)' });

(async () => {
  let conn;
  try {
    conn = await mysql.createConnection(cfg);
    console.log('✅ Sikeres kapcsolódás a szerverhez.');

    const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
    console.log('   MariaDB/MySQL verzió:', v);

    const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
    console.log('   Aktuális adatbázis:', db);

    const [[{ cs, co }]] = await conn.query(
      `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co
       FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [cfg.database]
    );
    console.log('   Karakterkészlet:', cs, '/ Collation:', co);
    if (cs !== 'utf8mb4') {
      console.warn('   ⚠️  FIGYELEM: nem utf8mb4 - az emojik és ékezetek hibásan tárolódhatnak!');
    }

    // írás/olvasás próba egy ideiglenes táblával, majd takarítás
    await conn.query('CREATE TABLE IF NOT EXISTS _conn_test (id INT PRIMARY KEY, txt VARCHAR(100)) CHARACTER SET utf8mb4');
    await conn.query('REPLACE INTO _conn_test (id, txt) VALUES (1, ?)', ['teszt üzenet 🎃']);
    const [[row]] = await conn.query('SELECT txt FROM _conn_test WHERE id = 1');
    console.log('   Írás/olvasás teszt:', row.txt === 'teszt üzenet 🎃' ? 'OK ✅' : 'HIBA ❌ (' + row.txt + ')');
    await conn.query('DROP TABLE _conn_test');

    console.log('\nMinden rendben - a szerver (npm start / docker compose up) ezekkel a beállításokkal el tud indulni.');
  } catch (e) {
    console.error('\n❌ Nem sikerült kapcsolódni vagy írni az adatbázisba:');
    console.error('  ', e.message);
    console.error('\nEllenőrizd:');
    console.error('  - fut-e a MariaDB a Synologyn (Package Center -> MariaDB 10)');
    console.error('  - a DB_HOST a NAS helyes LAN IP-je-e (nem localhost, ha a kód máshol fut)');
    console.error('  - a DB_USER/DB_PASSWORD helyes-e, és van-e jogosultsága a DB_NAME adatbázishoz');
    console.error('  - a MariaDB engedi-e a távoli (nem localhost) kapcsolatokat ehhez a felhasználóhoz');
    console.error('  - a NAS tűzfala nyitva van-e a 3306-os porton a kliens gép/konténer felé');
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
})();
