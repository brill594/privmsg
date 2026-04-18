import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";

function createEnv() {
  const requests = [];

  return {
    env: {
      DB: {},
      BUCKET: {},
      ASSETS: {
        fetch(request) {
          requests.push(request);
          return new Response("ok", { status: 200 });
        }
      }
    },
    requests
  };
}

test("serves the root asset for message routes without requesting index.html directly", async () => {
  const { env, requests } = createEnv();

  const response = await worker.fetch(new Request("https://example.com/m/test-id"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/");
});

test("serves the policy entry without requesting policy/index.html directly", async () => {
  const { env, requests } = createEnv();

  const response = await worker.fetch(new Request("https://example.com/policy"), env, {
    waitUntil() {}
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/policy/");
});
