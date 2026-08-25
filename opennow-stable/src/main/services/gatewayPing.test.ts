import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePingLatencyMs,
  parseUnixDefaultGateway,
  parseWindowsDefaultGateway,
} from "./gatewayPing";

test("selects the lowest-metric Windows IPv4 default route", () => {
  const output = `
0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.20     50
0.0.0.0          0.0.0.0       172.20.10.1     172.20.10.7     15
`;
  assert.equal(parseWindowsDefaultGateway(output), "172.20.10.1");
});

test("parses Linux and macOS default gateways", () => {
  assert.equal(parseUnixDefaultGateway("default via 192.168.110.1 dev wlan0"), "192.168.110.1");
  assert.equal(parseUnixDefaultGateway("gateway: 10.0.0.1"), "10.0.0.1");
});

test("parses localized and sub-millisecond ping output", () => {
  assert.equal(parsePingLatencyMs("time=12.4 ms"), 12.4);
  assert.equal(parsePingLatencyMs("время=7мс"), 7);
  assert.equal(parsePingLatencyMs("time<1ms"), 1);
});
