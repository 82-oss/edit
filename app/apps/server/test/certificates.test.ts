// Every child process verifies HTTPS with the system's certificates (Nov 17, the M4: the watch tool's FFmpeg read R2
// without them and failed every window with "certificate verify failed").
import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { shareCertificates, urlArgs } from "../src/tools.ts";

const system = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find((file) => fs.existsSync(file));

test.skipIf(system === undefined)("the system's certificates are given to every child by OpenSSL's own variable, never over one already set", () => {
  const env: Record<string, string | undefined> = {};
  shareCertificates(env);
  expect(env.SSL_CERT_FILE).toBe(system);
  const set: Record<string, string | undefined> = { SSL_CERT_FILE: "/somewhere/own.pem" };
  shareCertificates(set);
  expect(set.SSL_CERT_FILE).toBe("/somewhere/own.pem");
  // This server's own children have it too.
  expect(process.env.SSL_CERT_FILE).toBeTruthy();
  // And an HTTPS input is given them by name as well.
  expect(urlArgs("https://r2.example/a.mp4").slice(0, 2)).toEqual(["-ca_file", system!]);
});
