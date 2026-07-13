import assert from "node:assert/strict";
import test from "node:test";

import { serializeJsonLd } from "./json-ld.ts";

test("serializes ordinary JSON-LD without changing its data", () => {
  const value = { "@context": "https://schema.org", name: "Lake & Pine" };
  const serialized = serializeJsonLd(value);

  assert.deepEqual(JSON.parse(serialized), value);
});

test("prevents untrusted values from breaking out of the script element", () => {
  const attack = "</script><img src=x onerror=alert(1)>&\u2028\u2029";
  const serialized = serializeJsonLd({ serviceType: attack });

  assert.equal(serialized.includes("</script"), false);
  assert.equal(serialized.includes("<img"), false);
  assert.equal(serialized.includes("&"), false);
  assert.equal(serialized.includes("\u2028"), false);
  assert.equal(serialized.includes("\u2029"), false);
  assert.deepEqual(JSON.parse(serialized), { serviceType: attack });
});

test("rejects values that JSON cannot serialize", () => {
  assert.throws(
    () => serializeJsonLd(undefined),
    /JSON-LD value must be JSON-serializable/,
  );
});
