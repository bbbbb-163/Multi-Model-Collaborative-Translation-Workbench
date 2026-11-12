import { lookup } from "node:dns";
import { isIP, BlockList } from "node:net";
import { Agent } from "undici";
import { currentOwner, ADMIN_OWNER, PLATFORM_OWNER } from "./store.ts";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
// IPv6 public unicast only; block special-purpose ranges inside it as well.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
export function publicAddress(ip: string) {
  const family = isIP(ip);
  return family === 4
    ? !blocked.check(ip, "ipv4")
    : family === 6 && globalV6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}
export async function limitedJson(
  response: Response,
  limit = 4 * 1024 * 1024,
): Promise<any> {
  const tooLarge = () =>
    new Error("模型服务返回数据过大，请核对接口地址或联系服务提供方。");
  if (Number(response.headers.get("content-length") || 0) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) throw new Error("模型服务没有返回有效数据。");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
const denied = () =>
  new Error(
    "用户自接模型只能访问公网 HTTP(S) 地址，不能访问服务器内网或本机服务。",
  );
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) {
          callback(error, []);
          return;
        }
        if (
          !addresses.length ||
          addresses.some((a) => !publicAddress(a.address))
        ) {
          callback(denied(), []);
          return;
        }
        const candidates = options.family
          ? addresses.filter((a) => a.family === options.family)
          : addresses;
        if (!candidates.length) {
          callback(denied(), []);
          return;
        }
        // Return these exact validated addresses to the socket; never perform a second DNS lookup.
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      });
    },
  },
});
export async function networkFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  trusted = false,
): Promise<Response> {
  const owner = currentOwner(),
    allowPrivate = trusted || owner === ADMIN_OWNER || owner === PLATFORM_OWNER;
  let url = new URL(input instanceof Request ? input.url : String(input));
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("不支持的请求地址。");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && isIP(host) && !publicAddress(host)) throw denied();
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      ...(!allowPrivate ? { dispatcher } : {}),
    } as RequestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (init.redirect !== "follow" || redirect === 5) {
      await response.body?.cancel();
      throw new Error("已拒绝服务重定向，请核对接口地址。");
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("服务重定向缺少目标地址。");
    url = new URL(location, url);
    // Only credential-free media downloads may follow redirects.
    init = { ...init, headers: {}, method: "GET", body: undefined };
  }
  throw new Error("服务重定向次数过多。");
}
