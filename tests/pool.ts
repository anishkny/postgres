import { assertEquals, assertThrowsAsync, delay } from "../test_deps.ts";
import { Pool } from "../pool.ts";
import { DEFAULT_SETUP } from "./constants.ts";
import TEST_CONNECTION_PARAMS from "./config.ts";

function testPool(
  t: (pool: Pool) => void | Promise<void>,
  setupQueries?: Array<string> | null,
  lazy?: boolean,
) {
  // constructing Pool instantiates the connections,
  // so this has to be constructed for each test.
  const fn = async () => {
    const POOL = new Pool(TEST_CONNECTION_PARAMS, 10, lazy);
    try {
      for (const q of setupQueries || DEFAULT_SETUP) {
        await POOL.queryArray(q);
      }
      await t(POOL);
    } finally {
      await POOL.end();
    }
  };
  const name = t.name;
  Deno.test({ fn, name });
}

testPool(async function simpleQuery(POOL) {
  const result = await POOL.queryArray("SELECT * FROM ids;");
  assertEquals(result.rows.length, 2);
});

testPool(async function parametrizedQuery(POOL) {
  const result = await POOL.queryObject("SELECT * FROM ids WHERE id < $1;", 2);
  assertEquals(result.rows, [{ id: 1 }]);
});

testPool(async function aliasedObjectQuery(POOL) {
  const result = await POOL.queryObject({
    text: "SELECT ARRAY[1, 2, 3], 'DATA'",
    fields: ["IDS", "type"],
  });

  assertEquals(result.rows, [{ ids: [1, 2, 3], type: "DATA" }]);
});

testPool(async function objectQueryThrowsOnRepeatedFields(POOL) {
  await assertThrowsAsync(
    async () => {
      await POOL.queryObject({
        text: "SELECT 1",
        fields: ["FIELD_1", "FIELD_1"],
      });
    },
    TypeError,
    "The fields provided for the query must be unique",
  );
});

testPool(async function objectQueryThrowsOnNotMatchingFields(POOL) {
  await assertThrowsAsync(
    async () => {
      await POOL.queryObject({
        text: "SELECT 1",
        fields: ["FIELD_1", "FIELD_2"],
      });
    },
    RangeError,
    "The fields provided for the query don't match the ones returned as a result (1 expected, 2 received)",
  );
});

testPool(async function nativeType(POOL) {
  const result = await POOL.queryArray("SELECT * FROM timestamps;");
  const row = result.rows[0];

  const expectedDate = Date.UTC(2019, 1, 10, 6, 0, 40, 5);

  assertEquals(row[0].toUTCString(), new Date(expectedDate).toUTCString());

  await POOL.queryArray("INSERT INTO timestamps(dt) values($1);", new Date());
});

testPool(
  async function lazyPool(POOL) {
    await POOL.queryArray("SELECT 1;");
    assertEquals(POOL.available, 1);
    const p = POOL.queryArray("SELECT pg_sleep(0.1) is null, -1 AS id;");
    await delay(1);
    assertEquals(POOL.available, 0);
    assertEquals(POOL.size, 1);
    await p;
    assertEquals(POOL.available, 1);

    const qsThunks = [...Array(25)].map((_, i) =>
      POOL.queryArray("SELECT pg_sleep(0.1) is null, $1::text as id;", i)
    );
    const qsPromises = Promise.all(qsThunks);
    await delay(1);
    assertEquals(POOL.available, 0);
    const qs = await qsPromises;
    assertEquals(POOL.available, 10);
    assertEquals(POOL.size, 10);

    const result = qs.map((r) => r.rows[0][1]);
    const expected = [...Array(25)].map((_, i) => i.toString());
    assertEquals(result, expected);
  },
  null,
  true,
);

/**
 * @see https://github.com/bartlomieju/deno-postgres/issues/59
 */
testPool(async function returnedConnectionOnErrorOccurs(POOL) {
  assertEquals(POOL.available, 10);
  await assertThrowsAsync(async () => {
    await POOL.queryArray("SELECT * FROM notexists");
  });
  assertEquals(POOL.available, 10);
});

testPool(async function manyQueries(POOL) {
  assertEquals(POOL.available, 10);
  const p = POOL.queryArray("SELECT pg_sleep(0.1) is null, -1 AS id;");
  await delay(1);
  assertEquals(POOL.available, 9);
  assertEquals(POOL.size, 10);
  await p;
  assertEquals(POOL.available, 10);

  const qsThunks = [...Array(25)].map((_, i) =>
    POOL.queryArray("SELECT pg_sleep(0.1) is null, $1::text as id;", i)
  );
  const qsPromises = Promise.all(qsThunks);
  await delay(1);
  assertEquals(POOL.available, 0);
  const qs = await qsPromises;
  assertEquals(POOL.available, 10);
  assertEquals(POOL.size, 10);

  const result = qs.map((r) => r.rows[0][1]);
  const expected = [...Array(25)].map((_, i) => i.toString());
  assertEquals(result, expected);
});

testPool(async function transaction(POOL) {
  const client = await POOL.connect();
  let errored;
  let released;
  assertEquals(POOL.available, 9);

  try {
    await client.queryArray("BEGIN");
    await client.queryArray(
      "INSERT INTO timestamps(dt) values($1);",
      new Date(),
    );
    await client.queryArray("INSERT INTO ids(id) VALUES(3);");
    await client.queryArray("COMMIT");
  } catch (e) {
    await client.queryArray("ROLLBACK");
    errored = true;
    throw e;
  } finally {
    client.release();
    released = true;
  }
  assertEquals(errored, undefined);
  assertEquals(released, true);
  assertEquals(POOL.available, 10);
});
