#!/usr/bin/env node
// Standalone mock payment provider for local development of the Bug Zoo shop.
//   node zoo/mock-pay/src/bin.ts --port 4100 --webhook-url http://localhost:3001/api/webhooks/payment
import { parseArgs } from "node:util";
import { MockPay } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4100" },
    host: { type: "string", default: "127.0.0.1" },
    "webhook-url": { type: "string" },
    secret: { type: "string", default: "whsec_test" },
    manual: { type: "boolean", default: false },
  },
});

const pay = await MockPay.start({
  port: Number(values.port),
  host: values.host,
  defaultTenant: {
    webhookUrl: values["webhook-url"],
    webhookSecret: values.secret,
    webhooks: values.manual ? "manual" : "auto",
  },
});
console.log(`mock-pay listening on ${pay.url}`);
if (!values["webhook-url"]) console.log("no --webhook-url: events are recorded but not delivered");

const stop = () => void pay.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
