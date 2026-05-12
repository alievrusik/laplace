import fs from "node:fs";
import { HttpsProxyAgent } from "https-proxy-agent";

export function createTelegramAgent(config: {
  proxyUrl?: string;
  proxyCaCertPath?: string;
}): HttpsProxyAgent<string> | undefined {
  if (!config.proxyUrl) return undefined;

  const options = config.proxyCaCertPath
    ? { ca: fs.readFileSync(config.proxyCaCertPath) }
    : undefined;

  return new HttpsProxyAgent(config.proxyUrl, options);
}
